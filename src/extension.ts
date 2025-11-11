import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { findNodeAtOffset, getLocation, getNodeValue, Node, parseTree, ParseError, ParseOptions, printParseErrorCode } from 'jsonc-parser';
import {
  GraphLayoutPreset,
  VisualizerPanel,
  VisualizerSchemaPointerEntry,
  VisualizerSelectionInfo
} from './visualizerPanel';
import { SchemaNavigationTarget, SchemaValidator } from './schemaValidator';
import { AiService, EditProposal } from './aiService';
import { SummaryViewProvider } from './summaryView';

const SUPPORTED_LANGUAGES = new Set(['json', 'jsonc']);
const parseOptions: ParseOptions = { allowTrailingComma: true, disallowComments: false };
const schemaValidator = new SchemaValidator();
const autoSummaryDocs = new Set<string>();
const autoVisualizerDocs = new Set<string>();
const analysisCache = new Map<string, AnalysisSnapshot>();
const summaryCache = new Map<string, SummaryCacheEntry>();
const selectionFragmentDocs = new Set<string>();
const lastFocusedPathByDocument = new Map<string, string>();
const schemaPointerCache = new Map<string, Map<string, VisualizerSchemaPointerEntry>>();

let diagnostics: vscode.DiagnosticCollection;
let aiService: AiService;
let summaryViewProvider: SummaryViewProvider;
let outputChannel: vscode.OutputChannel;
interface AnalysisSnapshot {
  root: Node | undefined;
  data: unknown;
}

interface SummaryCacheEntry {
  hash: string;
  summary: string;
}

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('jsonAtlas');
  context.subscriptions.push(diagnostics);
  outputChannel = vscode.window.createOutputChannel('JSON Atlas');
  context.subscriptions.push(outputChannel);
  aiService = new AiService(context);
  summaryViewProvider = new SummaryViewProvider(context.extensionUri, aiService);

  if (vscode.window.activeTextEditor) {
    const document = vscode.window.activeTextEditor.document;
    void refreshDiagnostics(document);
    handleAutoFeatures(document, context);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void refreshDiagnostics(document);
      handleAutoFeatures(document, context);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void refreshDiagnostics(event.document);
      invalidateSummaryCacheForDocument(event.document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
      const key = document.uri.toString();
      autoSummaryDocs.delete(key);
      autoVisualizerDocs.delete(key);
      analysisCache.delete(key);
      schemaPointerCache.delete(key);
      VisualizerPanel.updateSchemaPointers(document.uri, undefined);
      invalidateSummaryCacheForDocument(document.uri);
      selectionFragmentDocs.delete(key);
      lastFocusedPathByDocument.delete(key);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const document = editor?.document;
      if (document) {
        handleAutoFeatures(document, context);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      handleSelectionChange(event.textEditor);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jsonAtlas')) {
        schemaValidator.reset();
        const affectedUris = Array.from(schemaPointerCache.keys()).map((key) => vscode.Uri.parse(key));
        schemaPointerCache.clear();
        for (const uri of affectedUris) {
          VisualizerPanel.updateSchemaPointers(uri, undefined);
        }
        if (vscode.window.activeTextEditor) {
          void refreshDiagnostics(vscode.window.activeTextEditor.document);
        }
      }
      if (event.affectsConfiguration('jsonAtlas.enableSummaryCaching')) {
        summaryCache.clear();
      }
      if (
        event.affectsConfiguration('jsonAtlas.autoGenerateSummary') ||
        event.affectsConfiguration('jsonAtlas.autoOpenVisualizer') ||
        event.affectsConfiguration('jsonAtlas.defaultVisualizerView') ||
        event.affectsConfiguration('jsonAtlas.graphAutoScale') ||
        event.affectsConfiguration('jsonAtlas.graphInitialScale') ||
        event.affectsConfiguration('jsonAtlas.graphMaxExpandedDepth') ||
        event.affectsConfiguration('jsonAtlas.graphLayoutPreset')
      ) {
        autoSummaryDocs.clear();
        autoVisualizerDocs.clear();
        const active = vscode.window.activeTextEditor?.document;
        if (active) {
          handleAutoFeatures(active, context);
        }
        VisualizerPanel.refreshConfiguration();
      }
    })
  );

  const showVisualizer = vscode.commands.registerCommand('jsonAtlas.showVisualizer', () => handleVisualizerCommand(context));
  context.subscriptions.push(showVisualizer);

  context.subscriptions.push(
    vscode.commands.registerCommand('jsonAtlas.setAiApiKey', () => aiService.promptForApiKey()),
    vscode.commands.registerCommand('jsonAtlas.clearAiApiKey', () => aiService.clearApiKey()),
    vscode.commands.registerCommand('jsonAtlas.summarizeJson', () => handleSummarizeCommand()),
    vscode.commands.registerCommand('jsonAtlas.explainSelection', () => handleExplainSelectionCommand()),
    vscode.commands.registerCommand('jsonAtlas.openVisualizerPanel', () => handleOpenVisualizerPanelCommand(context)),
    vscode.commands.registerCommand('jsonAtlas.generateEditProposals', () => handleGenerateEditProposals()),
    vscode.commands.registerCommand('jsonAtlas.goToSchemaDefinition', (args?: GoToSchemaDefinitionCommandArgs) =>
      handleGoToSchemaDefinitionCommand(args)
    )
  );

  context.subscriptions.push(
    summaryViewProvider,
    vscode.window.registerWebviewViewProvider(SummaryViewProvider.viewId, summaryViewProvider),
    vscode.languages.registerHoverProvider(Array.from(SUPPORTED_LANGUAGES), {
      provideHover(document, position) {
        return provideSchemaHover(document, position);
      }
    })
  );
}

async function refreshDiagnostics(document: vscode.TextDocument): Promise<void> {
  if (!isLintableDocument(document)) {
    diagnostics.delete(document.uri);
    return;
  }

  const analysis = analyzeDocument(document);
  const cacheKey = document.uri.toString();

  if (analysis.errors.length) {
    analysisCache.delete(cacheKey);
    schemaPointerCache.delete(cacheKey);
    VisualizerPanel.updateSchemaPointers(document.uri, undefined);
    diagnostics.set(document.uri, buildDiagnosticsFromErrors(document, analysis.errors));
    const first = analysis.errors[0];
    const location = document.positionAt(first.offset);
    const message = `JSON parse error: ${printParseErrorCode(first.error)} at ${location.line + 1}:${location.character + 1}`;
    VisualizerPanel.notifyInvalid(document.uri, message);
    return;
  }

  const snapshot: AnalysisSnapshot = { root: analysis.root, data: analysis.data };
  analysisCache.set(cacheKey, snapshot);
  const selectionPayload = buildRenderablePayload(document, snapshot, getSelectionsForDocument(document));
  VisualizerPanel.updateIfActive(document.uri, selectionPayload.data, selectionPayload.selection, {
    schemaPointers: selectionPayload.schemaPointers,
    layoutPreset: getConfiguredLayoutPreset(document)
  });
  recordSelectionFragmentState(document.uri, selectionPayload.selection);

  const schemaIssues = await schemaValidator.validate(document, analysis.root, analysis.data);
  diagnostics.set(document.uri, schemaIssues);
  rebuildSchemaPointers(document, analysis.root);
}

async function handleVisualizerCommand(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;

  if (!editor || !isLintableDocument(editor.document)) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to show the visualizer.');
    return;
  }

  const analysis = analyzeDocument(editor.document);

  if (analysis.errors.length) {
    const first = analysis.errors[0];
    const position = editor.document.positionAt(first.offset);
    const location = `${position.line + 1}:${position.character + 1}`;
    vscode.window.showErrorMessage(`Cannot render visualizer: ${printParseErrorCode(first.error)} at ${location}`);
    return;
  }

  const snapshot: AnalysisSnapshot = { root: analysis.root, data: analysis.data };
  analysisCache.set(editor.document.uri.toString(), snapshot);
  const selectionPayload = buildRenderablePayload(editor.document, snapshot, editor.selections);
  VisualizerPanel.render(
    context.extensionUri,
    selectionPayload.data,
    editor.document.uri,
    aiService,
    selectionPayload.selection,
    selectionPayload.schemaPointers,
    getConfiguredLayoutPreset(editor.document)
  );
  recordSelectionFragmentState(editor.document.uri, selectionPayload.selection);
}

async function handleSummarizeCommand() {
  const document = getSummarizableDocument();
  if (!document) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to summarize.');
    return;
  }

  await summarizeDocumentFor(document);
}

async function handleExplainSelectionCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isLintableDocument(editor.document)) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to explain a selection.');
    return;
  }

  const target = resolveExplainSelectionTarget(editor);
  if (!target) {
    void vscode.window.showInformationMessage('Select JSON content or place the cursor inside a JSON value to explain it.');
    return;
  }

  const docName = getDocumentName(editor.document);
  const label = target.label ?? target.path;
  const panelTitle = label ? `${docName} — ${label}` : `${docName} — Selection`;
  await summaryViewProvider.showGenerating(panelTitle);

  try {
    const explanation = await aiService.explainSelection({
      selectionText: target.text,
      jsonPath: target.path
    });
    if (!explanation) {
      summaryViewProvider.showError(panelTitle, 'Unable to explain selection (missing API key?).');
      void vscode.window.showWarningMessage('Unable to explain the selection (missing API key?).');
      return;
    }
    await summaryViewProvider.showSummary(panelTitle, explanation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaryViewProvider.showError(panelTitle, 'Failed to explain selection.');
    void vscode.window.showErrorMessage(`Failed to explain selection: ${message}`);
  }
}

async function handleGenerateEditProposals() {
  const document = getSummarizableDocument();
  if (!document) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to generate edit proposals.');
    return;
  }

  const docName = getDocumentName(document);
  const model = aiService.getSelectedModelOption();
  log(`Generate edit proposals requested for ${docName} using model ${model.id}.`);
  let proposals: EditProposal[] = [];
  const controller = new AbortController();

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating edit proposals for ${docName}`,
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: 'Contacting AI provider…' });
        token.onCancellationRequested(() => controller.abort());
        log('Waiting for provider response...');
        proposals = await aiService.generateEditProposals(document, controller.signal);
        log(`Provider returned ${proposals.length} proposals.`);
      }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      log('Edit proposal request was cancelled by the user.');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to generate edit proposals: ${message}`);
    log(`Edit proposal request failed: ${message}`);
    return;
  }

  if (!proposals.length) {
    void vscode.window.showInformationMessage('No edit proposals were generated.');
    log('No edit proposals were returned by the provider.');
    return;
  }

  const items = proposals.map((proposal, index) => ({
    label: proposal.title || `Proposal ${index + 1}`,
    description: truncate(proposal.summary || 'AI suggestion', 60),
    detail: formatMultiline(proposal.summary || 'AI suggestion'),
    proposal
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an edit proposal to inspect',
    matchOnDetail: true
  });

  if (!pick) {
    log('User dismissed the proposal picker.');
    return;
  }

  log(`User selected proposal "${pick.proposal.title}".`);
  await handleProposalSelection(document, pick.proposal);
}

async function handleOpenVisualizerPanelCommand(context: vscode.ExtensionContext) {
  const revealed = VisualizerPanel.revealExisting();
  if (revealed) {
    return;
  }
  await handleVisualizerCommand(context);
}

function analyzeDocument(document: vscode.TextDocument): { errors: ParseError[]; root: Node | undefined; data: unknown } {
  const errors: ParseError[] = [];
  const root = parseTree(document.getText(), errors, parseOptions);
  const data = root ? getNodeValue(root) : undefined;
  return { errors, root, data };
}

function buildDiagnosticsFromErrors(document: vscode.TextDocument, errors: ParseError[]): vscode.Diagnostic[] {
  return errors.map((error) => {
    const range = new vscode.Range(
      document.positionAt(error.offset),
      document.positionAt(error.offset + error.length)
    );
    const message = printParseErrorCode(error.error);
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'JSON Atlas';
    return diagnostic;
  });
}

function isLintableDocument(document: vscode.TextDocument) {
  return SUPPORTED_LANGUAGES.has(document.languageId);
}

function getSummarizableDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor;
  if (active && isLintableDocument(active.document)) {
    return active.document;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    if (isLintableDocument(editor.document)) {
      return editor.document;
    }
  }

  for (const doc of vscode.workspace.textDocuments) {
    if (isLintableDocument(doc)) {
      return doc;
    }
  }

  return undefined;
}

function handleAutoFeatures(document: vscode.TextDocument, context: vscode.ExtensionContext) {
  void maybeAutoGenerateSummary(document);
  void maybeAutoOpenVisualizer(document, context);
}

async function maybeAutoGenerateSummary(document: vscode.TextDocument) {
  if (!shouldAutoGenerateSummary() || !isLintableDocument(document)) {
    return;
  }
  if (!isDocumentActive(document)) {
    return;
  }
  const key = document.uri.toString();
  if (autoSummaryDocs.has(key)) {
    return;
  }
  autoSummaryDocs.add(key);
  await summarizeDocumentFor(document);
}

async function maybeAutoOpenVisualizer(document: vscode.TextDocument, context: vscode.ExtensionContext) {
  if (!shouldAutoOpenVisualizer() || !isLintableDocument(document) || isVisualizerExcluded(document)) {
    return;
  }
  if (!isDocumentActive(document)) {
    return;
  }
  const key = document.uri.toString();
  if (autoVisualizerDocs.has(key)) {
    return;
  }
  autoVisualizerDocs.add(key);
  await handleVisualizerCommand(context);
}

async function summarizeDocumentFor(document: vscode.TextDocument) {
  const docName = getDocumentName(document);
  const modelId = aiService.getSelectedModelId();
  const cacheKey = buildSummaryCacheKey(document.uri, modelId);
  const cachingEnabled = isSummaryCachingEnabled(document);
  let documentText: string | undefined;
  let fingerprint: string | undefined;

  if (cachingEnabled) {
    documentText = document.getText();
    fingerprint = computeSummaryFingerprint(documentText, modelId);
    const cached = summaryCache.get(cacheKey);
    if (cached && cached.hash === fingerprint) {
      await summaryViewProvider.showSummary(docName, cached.summary);
      return;
    }
  }

  await summaryViewProvider.showGenerating(docName);

  try {
    const summary = await aiService.summarizeDocument(document, documentText);
    if (!summary) {
      summaryCache.delete(cacheKey);
      summaryViewProvider.showError(docName, 'Unable to summarize JSON (missing API key?).');
      void vscode.window.showWarningMessage('Unable to summarize JSON (missing API key?).');
      return;
    }
    if (cachingEnabled && fingerprint) {
      summaryCache.set(cacheKey, { hash: fingerprint, summary });
    } else {
      summaryCache.delete(cacheKey);
    }
    await summaryViewProvider.showSummary(docName, summary);
  } catch (error) {
    summaryCache.delete(cacheKey);
    const message = error instanceof Error ? error.message : String(error);
    summaryViewProvider.showError(docName, 'Failed to summarize JSON.');
    void vscode.window.showErrorMessage(`Failed to summarize JSON: ${message}`);
  }
}

async function handleProposalSelection(document: vscode.TextDocument, proposal: EditProposal): Promise<void> {
  const action = await vscode.window.showQuickPick(['Apply', 'View Diff', 'Cancel'], {
    placeHolder: `${proposal.title}${proposal.summary ? ' — ' + proposal.summary : ''}`,
    ignoreFocusOut: true
  });

  if (!action || action === 'Cancel') {
    return;
  }

  if (action === 'Apply') {
    await applyProposalToDocument(document, proposal);
    return;
  }

  if (action === 'View Diff') {
    await showProposalDiff(document, proposal);
    const followup = await vscode.window.showQuickPick(['Apply Diff', 'Cancel'], {
      placeHolder: `Diff opened for "${proposal.title}". Choose an action.`,
      ignoreFocusOut: true
    });
    if (followup === 'Apply Diff') {
      await applyProposalToDocument(document, proposal);
    }
  }
}

async function showProposalDiff(document: vscode.TextDocument, proposal: EditProposal) {
  const preview = await vscode.workspace.openTextDocument({ content: proposal.updatedJson, language: document.languageId });
  const title = `${getDocumentName(document)} ↔ ${proposal.title}`;
  await vscode.commands.executeCommand('vscode.diff', document.uri, preview.uri, title);
}

async function applyProposalToDocument(document: vscode.TextDocument, proposal: EditProposal) {
  try {
    JSON.parse(proposal.updatedJson);
  } catch (error) {
    void vscode.window.showErrorMessage(`Proposal is not valid JSON: ${String(error)}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(document.uri, fullRange, proposal.updatedJson);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage('Failed to apply proposal to the document.');
    return;
  }

  const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
  if (config.get<boolean>('autoSaveOnEdit')) {
    await document.save();
  }

  VisualizerPanel.focusRoot(document.uri);

  void vscode.window.showInformationMessage(`Applied proposal "${proposal.title}".`);
  log(`Applied proposal "${proposal.title}" to ${getDocumentName(document)}.`);
}

function shouldAutoGenerateSummary() {
  return vscode.workspace.getConfiguration('jsonAtlas').get<boolean>('autoGenerateSummary', false);
}

function shouldAutoOpenVisualizer() {
  return vscode.workspace.getConfiguration('jsonAtlas').get<boolean>('autoOpenVisualizer', false);
}

function isVisualizerExcluded(document: vscode.TextDocument): boolean {
  const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
  const patterns = config.get<string[]>('visualizerExcludeGlobs', ['**/*.schema.json', '**/schemas/**']);
  if (!Array.isArray(patterns) || !patterns.length) {
    return false;
  }

  const filePath = document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const base = workspaceFolder?.uri.fsPath ?? '';
  const relativePath = base && filePath.startsWith(base) ? filePath.slice(base.length + (base.endsWith('/') ? 0 : 1)) : filePath;

  return patterns.some((pattern) => minimatch(relativePath, pattern, { nocase: true, dot: true, matchBase: true }));
}

function isSummaryCachingEnabled(document: vscode.TextDocument): boolean {
  return vscode.workspace.getConfiguration('jsonAtlas', document.uri).get<boolean>('enableSummaryCaching', true);
}

function isDocumentActive(document: vscode.TextDocument) {
  return vscode.window.activeTextEditor?.document === document;
}

function buildSummaryCacheKey(uri: vscode.Uri, modelId: string): string {
  return `${uri.toString()}::${modelId}`;
}

function computeSummaryFingerprint(text: string, modelId: string): string {
  return createHash('sha256').update(modelId).update('\n').update(text).digest('hex');
}

function invalidateSummaryCacheForDocument(uri: vscode.Uri) {
  const prefix = `${uri.toString()}::`;
  for (const key of Array.from(summaryCache.keys())) {
    if (key.startsWith(prefix)) {
      summaryCache.delete(key);
    }
  }
}

function rebuildSchemaPointers(document: vscode.TextDocument, root: Node | undefined) {
  const map = buildSchemaPointerMap(document, root);
  const key = document.uri.toString();
  if (map) {
    schemaPointerCache.set(key, map);
  } else {
    schemaPointerCache.delete(key);
  }
  VisualizerPanel.updateSchemaPointers(document.uri, map);
}

function buildSchemaPointerMap(
  document: vscode.TextDocument,
  root: Node | undefined
): Map<string, VisualizerSchemaPointerEntry> | undefined {
  if (!root) {
    return undefined;
  }

  const schemaInfo = schemaValidator.getSchemaInfo(document.uri);
  if (!schemaInfo) {
    return undefined;
  }

  const result = new Map<string, VisualizerSchemaPointerEntry>();
  const visit = (node: Node, path: JsonPath) => {
    const target = schemaValidator.resolveNavigationTarget(document.uri, path);
    if (target) {
      result.set(encodeVisualizerPath(path), {
        pointer: target.pointer,
        uri: target.uri,
        offset: target.offset,
        length: target.length,
        title: target.title,
        description: target.description
      });
    }

    if (node.type === 'object') {
      for (const property of node.children ?? []) {
        if (property.type !== 'property' || !property.children || property.children.length < 2) {
          continue;
        }
        const keyNode = property.children[0];
        const valueNode = property.children[1];
        const key = extractPropertyKey(keyNode);
        if (typeof key === 'undefined') {
          continue;
        }
        visit(valueNode, path.concat([key]));
      }
      return;
    }

    if (node.type === 'array') {
      (node.children ?? []).forEach((child, index) => {
        visit(child, path.concat([index]));
      });
    }
  };

  visit(root, []);
  return result.size ? result : undefined;
}

function handleSelectionChange(editor: vscode.TextEditor) {
  if (!isLintableDocument(editor.document)) {
    return;
  }
  if (!VisualizerPanel.isDocumentActive(editor.document.uri)) {
    return;
  }
  const analysis = getOrComputeAnalysis(editor.document);
  if (!analysis) {
    return;
  }
  const payload = buildRenderablePayload(editor.document, analysis, editor.selections);
  VisualizerPanel.updateSelection(editor.document.uri, payload.selection);

  const key = editor.document.uri.toString();
  const hasSelectionFragment = Boolean(payload.selection?.active);
  const showingFragment = selectionFragmentDocs.has(key);

  if (hasSelectionFragment) {
    VisualizerPanel.updateIfActive(editor.document.uri, payload.data, payload.selection, {
      focusRoot: true,
      resetLayout: true,
      schemaPointers: payload.schemaPointers,
      layoutPreset: getConfiguredLayoutPreset(editor.document)
    });
    recordSelectionFragmentState(editor.document.uri, payload.selection);
    return;
  }

  if (showingFragment) {
    VisualizerPanel.updateIfActive(editor.document.uri, analysis.data, undefined, {
      focusRoot: true,
      resetLayout: true,
      schemaPointers: payload.schemaPointers,
      layoutPreset: getConfiguredLayoutPreset(editor.document)
    });
    recordSelectionFragmentState(editor.document.uri, undefined);
  }

  const hasActiveSelection = editor.selections.some((selection) => !selection.isEmpty);
  if (!hasActiveSelection) {
    const focusPathKey = getVisualizerPathForCursor(editor.document, editor.selection.active);
    if (focusPathKey) {
      if (lastFocusedPathByDocument.get(key) !== focusPathKey) {
        lastFocusedPathByDocument.set(key, focusPathKey);
        VisualizerPanel.focusPath(editor.document.uri, focusPathKey);
      }
    }
  }
}

function getSelectionsForDocument(document: vscode.TextDocument): readonly vscode.Selection[] | undefined {
  const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
  return editor?.selections;
}

function resolveExplainSelectionTarget(editor: vscode.TextEditor): ExplainSelectionTarget | undefined {
  const document = editor.document;
  const analysis = getOrComputeAnalysis(document);
  let fullText: string | undefined;
  const ensureFullText = () => {
    if (typeof fullText === 'undefined') {
      fullText = document.getText();
    }
    return fullText;
  };

  for (const selection of editor.selections) {
    if (selection.isEmpty) {
      continue;
    }
    const text = document.getText(selection).trim();
    if (!text) {
      continue;
    }
    const offset = document.offsetAt(selection.start);
    const endOffset = document.offsetAt(selection.end);
    const candidatePaths = analysis?.root ? collectJsonPathsWithinRange(analysis.root, offset, endOffset) : [];
    const summaries = buildPathSummaries(candidatePaths);
    const fallbackPath = getJsonPathForOffset(document, offset, ensureFullText());
    const path = summaries.prompt ?? fallbackPath;
    const label = summaries.label ?? path;
    return { text, path, label };
  }

  if (!analysis?.root) {
    return undefined;
  }

  const offset = document.offsetAt(editor.selection.active);
  const node = findNodeAtOffset(analysis.root, offset, true);
  if (!node) {
    return undefined;
  }

  const start = document.positionAt(node.offset);
  const end = document.positionAt(node.offset + node.length);
  const text = document.getText(new vscode.Range(start, end)).trim();
  if (!text) {
    return undefined;
  }

  const pathSegments = getJsonPathSegments(document, node.offset, ensureFullText());
  const summaries = pathSegments ? buildPathSummaries([pathSegments]) : {};
  const path = summaries.prompt ?? (pathSegments ? formatJsonPath(pathSegments) : undefined);
  const label = summaries.label ?? path;
  return { text, path, label };
}

function getOrComputeAnalysis(document: vscode.TextDocument): AnalysisSnapshot | undefined {
  const key = document.uri.toString();
  const cached = analysisCache.get(key);
  if (cached) {
    return cached;
  }
  const analysis = analyzeDocument(document);
  if (analysis.errors.length) {
    return undefined;
  }
  const snapshot: AnalysisSnapshot = { root: analysis.root, data: analysis.data };
  analysisCache.set(key, snapshot);
  return snapshot;
}

function getDocumentName(document: vscode.TextDocument): string {
  return document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.path;
}

async function provideSchemaHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
  if (!isLintableDocument(document) || !isSchemaValidationEnabled(document)) {
    return undefined;
  }

  const path = getJsonPathSegments(document, document.offsetAt(position));
  if (!path) {
    return undefined;
  }

  const ready = await ensureSchemaNavigationData(document);
  if (!ready) {
    return undefined;
  }

  const target = schemaValidator.resolveNavigationTarget(document.uri, path);
  if (!target) {
    return undefined;
  }

  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = true;

  const title = target.title?.trim() || 'Schema definition';
  markdown.appendMarkdown(`**${escapeMarkdown(title)}**\n\n`);

  const description = target.description?.trim();
  if (description) {
    markdown.appendMarkdown(`${escapeMarkdown(description)}\n\n`);
  }

  const jsonPath = formatJsonPath(path);
  markdown.appendMarkdown(`JSON Path: \`${escapeMarkdown(jsonPath)}\`\n\n`);
  if (target.pointer) {
    markdown.appendMarkdown(`Pointer: \`${escapeMarkdown(target.pointer)}\`\n\n`);
  }

  const commandArgs: GoToSchemaDefinitionCommandArgs = {
    documentUri: document.uri.toString(),
    path
  };
  const commandUri = vscode.Uri.parse(
    `command:jsonAtlas.goToSchemaDefinition?${encodeURIComponent(JSON.stringify(commandArgs))}`
  );
  markdown.appendMarkdown(`[Go to schema definition](${commandUri.toString()})`);

  return new vscode.Hover(markdown);
}

async function handleGoToSchemaDefinitionCommand(args?: GoToSchemaDefinitionCommandArgs): Promise<void> {
  const argUri = typeof args?.documentUri === 'string' ? vscode.Uri.parse(args.documentUri) : undefined;
  const activeEditor = vscode.window.activeTextEditor;
  const targetUri = argUri ?? activeEditor?.document.uri;
  if (!targetUri) {
    void vscode.window.showInformationMessage('Open a JSON document to locate its schema definition.');
    return;
  }

  const document =
    vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === targetUri.toString()) ??
    (await vscode.workspace.openTextDocument(targetUri));

  let path = normalizeJsonPath(args?.path);
  if (!path && activeEditor && activeEditor.document.uri.toString() === targetUri.toString()) {
    path = getJsonPathSegments(document, document.offsetAt(activeEditor.selection.active));
  }
  if (!path) {
    void vscode.window.showInformationMessage('Place the cursor inside a JSON value to locate its schema definition.');
    return;
  }

  const ready = await ensureSchemaNavigationData(document);
  if (!ready) {
    void vscode.window.showInformationMessage('Schema definition not available (validation disabled or schema missing).');
    return;
  }

  const target = schemaValidator.resolveNavigationTarget(document.uri, path);
  if (!target) {
    void vscode.window.showInformationMessage('Schema definition not found for this location.');
    return;
  }

  try {
    await revealSchemaNavigationTarget(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Unable to open schema definition: ${message}`);
  }
}

function normalizeJsonPath(value: unknown): JsonPath | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: JsonPath = [];
  for (const segment of value) {
    if (typeof segment === 'number' || typeof segment === 'string') {
      result.push(segment);
      continue;
    }
    return undefined;
  }
  return result;
}

function isSchemaValidationEnabled(document: vscode.TextDocument): boolean {
  return vscode.workspace.getConfiguration('jsonAtlas', document.uri).get<boolean>('enableSchemaValidation', false);
}

async function revealSchemaNavigationTarget(target: SchemaNavigationTarget): Promise<void> {
  const document = await vscode.workspace.openTextDocument(target.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const offset = typeof target.offset === 'number' ? target.offset : 0;
  const length = typeof target.length === 'number' ? target.length : 0;
  const start = document.positionAt(offset);
  const end = length > 0 ? document.positionAt(offset + length) : start;
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-!])/g, '\\$1');
}

function getConfiguredLayoutPreset(document: vscode.TextDocument): GraphLayoutPreset {
  const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
  const value = config.get<string>('graphLayoutPreset', 'balanced');
  if (value === 'compact' || value === 'relaxed') {
    return value;
  }
  return 'balanced';
}

async function ensureSchemaNavigationData(document: vscode.TextDocument): Promise<boolean> {
  if (!isLintableDocument(document) || !isSchemaValidationEnabled(document)) {
    return false;
  }

  const analysis = getOrComputeAnalysis(document);
  if (!analysis?.root) {
    return false;
  }

  if (!schemaValidator.getSchemaInfo(document.uri)) {
    await schemaValidator.validate(document, analysis.root, analysis.data);
  }

  if (!schemaValidator.getSchemaInfo(document.uri)) {
    return false;
  }

  const key = document.uri.toString();
  if (!schemaPointerCache.has(key)) {
    const map = buildSchemaPointerMap(document, analysis.root);
    if (map) {
      schemaPointerCache.set(key, map);
    }
  }

  return schemaPointerCache.has(key);
}

function log(message: string) {
  if (!outputChannel) {
    return;
  }
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 1)}…`;
}

function formatMultiline(value: string, width = 80): string {
  if (!value) {
    return '';
  }
  const regex = new RegExp(`(.{1,${width}})(\\s|$)`, 'g');
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = regex.exec(value)) !== null) {
    parts.push(match[1].trim());
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex).trim());
  }
  return parts.join('\n');
}

function recordSelectionFragmentState(uri: vscode.Uri, selection?: VisualizerSelectionInfo) {
  const key = uri.toString();
  if (selection?.active) {
    selectionFragmentDocs.add(key);
  } else {
    selectionFragmentDocs.delete(key);
  }
}

function buildRenderablePayload(
  document: vscode.TextDocument,
  analysis: AnalysisSnapshot,
  selections?: readonly vscode.Selection[]
): { data: unknown; selection?: VisualizerSelectionInfo; schemaPointers?: Map<string, VisualizerSchemaPointerEntry> } {
  const schemaPointers = schemaPointerCache.get(document.uri.toString());
  const ranges = normalizeSelections(document, selections);
  if (!ranges.length || !analysis.root) {
    return { data: analysis.data, schemaPointers };
  }

  const fragment = extractSelectionFragment(analysis.root, ranges);
  if (typeof fragment === 'undefined') {
    return { data: analysis.data, schemaPointers };
  }

  return {
    data: fragment,
    selection: buildSelectionSummary(ranges),
    schemaPointers
  };
}

interface SelectionRangeInfo {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

type JsonPath = (string | number)[];

interface ExplainSelectionTarget {
  text: string;
  path?: string;
  label?: string;
}

interface GoToSchemaDefinitionCommandArgs {
  documentUri?: string;
  path?: JsonPath;
}

function normalizeSelections(
  document: vscode.TextDocument,
  selections?: readonly vscode.Selection[]
): SelectionRangeInfo[] {
  if (!selections || !selections.length) {
    return [];
  }

  return selections
    .filter((selection) => !selection.isEmpty)
    .map((selection) => {
      const startOffset = document.offsetAt(selection.start);
      const endOffset = document.offsetAt(selection.end);
      if (startOffset === endOffset) {
        return undefined;
      }
      const startLine = Math.min(selection.start.line, selection.end.line);
      const endLine = Math.max(selection.start.line, selection.end.line);
      return {
        start: Math.min(startOffset, endOffset),
        end: Math.max(startOffset, endOffset),
        startLine,
        endLine
      };
    })
    .filter((range): range is SelectionRangeInfo => typeof range !== 'undefined');
}

function buildSelectionSummary(ranges: SelectionRangeInfo[]): VisualizerSelectionInfo {
  if (!ranges.length) {
    return { active: false };
  }
  const minLine = ranges.reduce((min, range) => Math.min(min, range.startLine), Number.POSITIVE_INFINITY);
  const maxLine = ranges.reduce((max, range) => Math.max(max, range.endLine), Number.NEGATIVE_INFINITY);
  const base =
    Number.isFinite(minLine) && Number.isFinite(maxLine)
      ? minLine === maxLine
        ? `Line ${minLine + 1}`
        : `Lines ${minLine + 1}-${maxLine + 1}`
      : 'Selection';
  const summary = ranges.length > 1 ? `${base} (${ranges.length} selections)` : base;
  return { active: true, summary, startLine: Number.isFinite(minLine) ? minLine : undefined, endLine: Number.isFinite(maxLine) ? maxLine : undefined };
}

function extractSelectionFragment(root: Node, ranges: SelectionRangeInfo[]): unknown | undefined {
  const offsetRanges = ranges.map((range) => ({ start: range.start, end: range.end }));
  const result = cloneNodeForSelection(root, offsetRanges);
  return result?.matched ? result.value : undefined;
}

function getJsonPathForOffset(document: vscode.TextDocument, offset: number, documentText?: string): string | undefined {
  const segments = getJsonPathSegments(document, offset, documentText);
  return segments ? formatJsonPath(segments) : undefined;
}

function getVisualizerPathForCursor(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const offset = document.offsetAt(position);
  const segments = getJsonPathSegments(document, offset);
  if (!segments) {
    return undefined;
  }
  return encodeVisualizerPath(segments);
}

function getJsonPathSegments(document: vscode.TextDocument, offset: number, documentText?: string): JsonPath | undefined {
  try {
    const text = typeof documentText === 'string' ? documentText : document.getText();
    const location = getLocation(text, offset);
    if (!location) {
      return undefined;
    }
    return location.path ?? [];
  } catch {
    return undefined;
  }
}

function formatJsonPath(segments: JsonPath): string {
  if (!segments.length) {
    return '$';
  }

  let path = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${segment}]`;
      continue;
    }

    if (/^[A-Za-z_][\w$]*$/.test(segment)) {
      path += `.${segment}`;
      continue;
    }

    const escaped = segment.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    path += `['${escaped}']`;
  }
  return path;
}

function encodeVisualizerPath(segments: JsonPath): string {
  return JSON.stringify(segments);
}

function collectJsonPathsWithinRange(root: Node, start: number, end: number): JsonPath[] {
  const paths: JsonPath[] = [];
  const seen = new Set<string>();

  const pushPath = (path: JsonPath) => {
    if (!path.length) {
      return;
    }
    const key = serializePath(path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    paths.push(path);
  };

  const visit = (node: Node, currentPath: JsonPath) => {
    const nodeStart = node.offset;
    const nodeEnd = node.offset + node.length;
    if (nodeEnd <= start || nodeStart >= end) {
      return;
    }

    const fullyInside = currentPath.length > 0 && nodeStart >= start && nodeEnd <= end;
    if (fullyInside) {
      pushPath(currentPath);
      return;
    }

    if (node.type === 'object') {
      for (const property of node.children ?? []) {
        if (property.type !== 'property' || !property.children || property.children.length < 2) {
          continue;
        }
        const keyNode = property.children[0];
        const valueNode = property.children[1];
        const key = extractPropertyKey(keyNode);
        if (typeof key === 'undefined') {
          continue;
        }
        visit(valueNode, currentPath.concat([key]));
      }
      return;
    }

    if (node.type === 'array') {
      (node.children ?? []).forEach((child, index) => {
        visit(child, currentPath.concat([index]));
      });
      return;
    }

    if (currentPath.length) {
      pushPath(currentPath);
    }
  };

  visit(root, []);
  return paths;
}

function buildPathSummaries(paths: JsonPath[]): { prompt?: string; label?: string } {
  if (!paths.length) {
    return {};
  }

  const promptValues = dedupeStrings(paths.map((segments) => formatJsonPath(segments)));
  const labelValues = dedupeStrings(
    paths
      .map((segments) => formatTopLevelLabel(segments))
      .filter((value): value is string => Boolean(value))
  );

  return {
    prompt: summarizeStrings(promptValues),
    label: summarizeStrings(labelValues)
  };
}

function summarizeStrings(values: string[], max = 3): string | undefined {
  if (!values.length) {
    return undefined;
  }
  if (values.length <= max) {
    return values.join(', ');
  }
  const remaining = values.length - max;
  return `${values.slice(0, max).join(', ')} + ${remaining} more`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function formatTopLevelLabel(path: JsonPath): string | undefined {
  if (!path.length) {
    return undefined;
  }
  const [first] = path;
  if (typeof first === 'number') {
    return `[${first}]`;
  }
  return String(first);
}

function serializePath(path: JsonPath): string {
  if (!path.length) {
    return '';
  }
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`))
    .join('');
}

function extractPropertyKey(node: Node): string | undefined {
  if (typeof node.value === 'string' && node.value.length) {
    return node.value;
  }
  if (typeof node.value === 'number' || typeof node.value === 'boolean') {
    return String(node.value);
  }
  return undefined;
}

interface OffsetRange {
  start: number;
  end: number;
}

interface CloneResult {
  matched: boolean;
  value?: unknown;
}

function cloneNodeForSelection(node: Node | undefined, ranges: OffsetRange[]): CloneResult | undefined {
  if (!node) {
    return { matched: false };
  }

  const nodeStart = node.offset;
  const nodeEnd = node.offset + node.length;
  const intersects = ranges.some((range) => nodeStart < range.end && nodeEnd > range.start);
  if (!intersects) {
    return { matched: false };
  }

  if (node.type === 'object') {
    const result: Record<string, unknown> = {};
    let matched = false;
    for (const property of node.children ?? []) {
      if (property.type !== 'property' || !property.children || property.children.length < 2) {
        continue;
      }
      const keyNode = property.children[0];
      const valueNode = property.children[1];
      const childResult = cloneNodeForSelection(valueNode, ranges);
      if (childResult?.matched) {
        const key =
          typeof keyNode.value === 'string'
            ? keyNode.value
            : typeof keyNode.value === 'number' || typeof keyNode.value === 'boolean'
              ? String(keyNode.value)
              : keyNode.value ?? '';
        result[key] = childResult.value;
        matched = true;
      }
    }
    if (matched) {
      return { matched: true, value: result };
    }
    return { matched: true, value: getNodeValue(node) };
  }

  if (node.type === 'array') {
    const result: unknown[] = [];
    let matched = false;
    (node.children ?? []).forEach((child, index) => {
      const childResult = cloneNodeForSelection(child, ranges);
      if (childResult?.matched) {
        result[index] = childResult.value;
        matched = true;
      }
    });
    if (matched) {
      return { matched: true, value: result };
    }
    return { matched: true, value: getNodeValue(node) };
  }

  return { matched: true, value: getNodeValue(node) };
}

export function deactivate() {
  diagnostics?.dispose();
}
