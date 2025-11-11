import { createHash } from 'crypto';
import * as nodePath from 'path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { findNodeAtLocation, findNodeAtOffset, getLocation, getNodeValue, Node, ParseError, printParseErrorCode } from 'jsonc-parser';
import { GraphLayoutPreset, VisualizerPanel, VisualizerSchemaPointerEntry, VisualizerSelectionInfo } from './visualizerPanel';
import { SchemaInsight, SchemaNavigationTarget, SchemaValidator } from './schemaValidator';
import { SchemaInsightsViewProvider, VisualizerSchemaInsight } from './schemaInsightsView';
import { AiService, EditProposal, SchemaUpdateProposal } from './aiService';
import { SummaryViewProvider } from './summaryView';
import { SchemaAssociationStore } from './schemaAssociations';
import { analyzeJsonText, JsonAnalysisResult } from './jsonAnalysis';
import { WorkspaceSchemaScanner } from './workspaceSchemaScanner';

const SUPPORTED_LANGUAGES = new Set(['json', 'jsonc']);
const schemaValidator = new SchemaValidator();
const autoSummaryDocs = new Set<string>();
const autoVisualizerDocs = new Set<string>();
const analysisCache = new Map<string, AnalysisSnapshot>();
const summaryCache = new Map<string, SummaryCacheEntry>();
const selectionFragmentDocs = new Set<string>();
const lastFocusedPathByDocument = new Map<string, string>();
const schemaPointerCache = new Map<string, Map<string, VisualizerSchemaPointerEntry>>();
const schemaInsightsCache = new Map<string, VisualizerSchemaInsight[]>();

let diagnostics: vscode.DiagnosticCollection;
let aiService: AiService;
let summaryViewProvider: SummaryViewProvider;
let schemaInsightsProvider: SchemaInsightsViewProvider;
let outputChannel: vscode.OutputChannel;
let schemaAssociationStore: SchemaAssociationStore;
interface AnalysisSnapshot {
  root: Node | undefined;
  data: unknown;
}

interface SummaryCacheEntry {
  hash: string;
  summary: string;
}

interface SchemaQuickPickItem extends vscode.QuickPickItem {
  uri?: vscode.Uri;
  action?: 'browse' | 'input' | 'clear';
}

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection('jsonAtlas');
  context.subscriptions.push(diagnostics);
  outputChannel = vscode.window.createOutputChannel('JSON Atlas');
  context.subscriptions.push(outputChannel);
  aiService = new AiService(context);
  summaryViewProvider = new SummaryViewProvider(context.extensionUri, aiService);
  const workspaceSchemaScanner = new WorkspaceSchemaScanner(schemaValidator);
  schemaInsightsProvider = new SchemaInsightsViewProvider(context.extensionUri, workspaceSchemaScanner);
  schemaAssociationStore = new SchemaAssociationStore();
  schemaValidator.setAssociationStore(schemaAssociationStore);

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
      schemaInsightsCache.delete(key);
      schemaInsightsProvider.clearInsights(document.uri);
      VisualizerPanel.updateSchemaInsights(document.uri, undefined);
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
        const insightUris = Array.from(schemaInsightsCache.keys()).map((key) => vscode.Uri.parse(key));
        schemaInsightsCache.clear();
        for (const uri of insightUris) {
          schemaInsightsProvider.clearInsights(uri);
          VisualizerPanel.updateSchemaInsights(uri, undefined);
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
    vscode.commands.registerCommand('jsonAtlas.generateSchemaUpdates', () => handleGenerateSchemaUpdates()),
    vscode.commands.registerCommand('jsonAtlas.associateSchema', () => handleAssociateSchemaCommand()),
    vscode.commands.registerCommand('jsonAtlas.goToSchemaDefinition', (args?: GoToSchemaDefinitionCommandArgs) =>
      handleGoToSchemaDefinitionCommand(args)
    ),
    vscode.commands.registerCommand('jsonAtlas.showWorkspaceSchemaDashboard', async () => {
      await schemaInsightsProvider.revealView();
      await schemaInsightsProvider.runWorkspaceScan();
    }),
    vscode.commands.registerCommand('jsonAtlas.scanWorkspaceSchemas', () =>
      schemaInsightsProvider.runWorkspaceScan({ reveal: true })
    ),
    vscode.commands.registerCommand('jsonAtlas.openWorkspaceSchemaFailures', () =>
      schemaInsightsProvider.showWorkspaceFailurePicker()
    ),
    vscode.commands.registerCommand('jsonAtlas.exportWorkspaceSchemaReport', () =>
      schemaInsightsProvider.exportWorkspaceReport({ forceRescan: true })
    )
  );

  context.subscriptions.push(
    summaryViewProvider,
    vscode.window.registerWebviewViewProvider(SummaryViewProvider.viewId, summaryViewProvider),
    schemaInsightsProvider,
    vscode.window.registerWebviewViewProvider(SchemaInsightsViewProvider.viewId, schemaInsightsProvider),
    vscode.languages.registerCompletionItemProvider(Array.from(SUPPORTED_LANGUAGES), {
      provideCompletionItems(document, position, token, context) {
        return provideSchemaCompletionItems(document, position, context);
      }
    }, '"', ':', ',', '{'),
    vscode.languages.registerHoverProvider(Array.from(SUPPORTED_LANGUAGES), {
      provideHover(document, position) {
        return provideSchemaHover(document, position);
      }
    }),
    vscode.languages.registerCodeLensProvider(Array.from(SUPPORTED_LANGUAGES), {
      provideCodeLenses(document) {
        return provideSchemaCodeLenses(document);
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
    schemaInsightsCache.delete(cacheKey);
    VisualizerPanel.updateSchemaInsights(document.uri, undefined);
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
  const schemaIssues = await schemaValidator.validate(document, analysis.root, analysis.data);
  diagnostics.set(document.uri, schemaIssues);
  const schemaInsights = schemaValidator.getSchemaInsights(document.uri);
  const insightsPayload = buildVisualizerSchemaInsights(document, analysis.root, schemaInsights);
  schemaInsightsCache.set(cacheKey, insightsPayload);
  if (shouldDisplayInsights(document)) {
    schemaInsightsProvider.setInsights(document, insightsPayload);
  }
  VisualizerPanel.updateSchemaInsights(document.uri, insightsPayload);
  rebuildSchemaPointers(document, analysis.root);
  VisualizerPanel.updateIfActive(document.uri, selectionPayload.data, selectionPayload.selection, {
    schemaPointers: selectionPayload.schemaPointers,
    layoutPreset: getConfiguredLayoutPreset(document)
  });
  recordSelectionFragmentState(document.uri, selectionPayload.selection);
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
  const insightsPayload = buildVisualizerSchemaInsights(
    editor.document,
    snapshot.root,
    schemaValidator.getSchemaInsights(editor.document.uri)
  );
  schemaInsightsCache.set(editor.document.uri.toString(), insightsPayload);
  if (shouldDisplayInsights(editor.document)) {
    schemaInsightsProvider.setInsights(editor.document, insightsPayload);
  }
  VisualizerPanel.updateSchemaInsights(editor.document.uri, insightsPayload);
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

async function handleGenerateSchemaUpdates() {
  const document = getSummarizableDocument();
  if (!document) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to generate schema updates.');
    return;
  }

  if (!isSchemaValidationEnabled(document)) {
    void vscode.window.showInformationMessage('Enable schema validation in settings to generate schema updates.');
    return;
  }

  const ready = await ensureSchemaNavigationData(document);
  if (!ready) {
    void vscode.window.showInformationMessage('Schema data is unavailable. Ensure the schema path is configured and the document parses correctly.');
    return;
  }

  const schemaInfo = schemaValidator.getSchemaInfo(document.uri);
  if (!schemaInfo) {
    void vscode.window.showInformationMessage('Unable to locate the schema for this document.');
    return;
  }

  const schemaDocument = await vscode.workspace.openTextDocument(schemaInfo.uri);
  const schemaName = getDocumentName(schemaDocument);
  const model = aiService.getSelectedModelOption();
  log(`Generate schema updates requested for ${schemaName} using model ${model.id}.`);

  const controller = new AbortController();
  let proposals: SchemaUpdateProposal[] = [];

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating schema updates for ${schemaName}`,
        cancellable: true
      },
      async (progress, token) => {
        progress.report({ message: 'Analyzing documents…' });
        token.onCancellationRequested(() => controller.abort());
        proposals = await aiService.generateSchemaProposals(document, schemaInfo, controller.signal);
        log(`Provider returned ${proposals.length} schema proposals.`);
      }
    );
  } catch (error) {
    if (controller.signal.aborted) {
      log('Schema update request was cancelled by the user.');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Failed to generate schema updates: ${message}`);
    log(`Schema update request failed: ${message}`);
    return;
  }

  if (!proposals.length) {
    void vscode.window.showInformationMessage('No schema updates were generated.');
    log('No schema update proposals were returned by the provider.');
    return;
  }

  const items = proposals.map((proposal, index) => ({
    label: proposal.title || `Schema Proposal ${index + 1}`,
    description: truncate(proposal.summary || 'AI schema update', 60),
    detail: formatMultiline(proposal.summary || 'AI schema update'),
    proposal
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a schema update proposal to inspect',
    matchOnDetail: true
  });

  if (!pick) {
    log('User dismissed the schema proposal picker.');
    return;
  }

  log(`User selected schema proposal "${pick.proposal.title}".`);
  await handleSchemaProposalSelection(document, schemaDocument, pick.proposal);
}

async function handleAssociateSchemaCommand() {
  const document = getSummarizableDocument();
  if (!document || !isLintableDocument(document)) {
    vscode.window.showErrorMessage('Open a JSON or JSONC document to associate a schema.');
    return;
  }
  if (!schemaAssociationStore) {
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage('Schema associations require the document to be inside an open workspace folder.');
    return;
  }

  const currentAssignment = await schemaAssociationStore.getSchemaReference(document.uri);
  const items = await buildSchemaQuickPickItems(document, currentAssignment);
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a schema to associate with this document',
    matchOnDetail: true
  });

  if (!pick) {
    return;
  }

  if (pick.action === 'clear') {
    await schemaAssociationStore.clearSchemaReference(document.uri);
    void vscode.window.showInformationMessage('Cleared schema association for this document.');
    await refreshDiagnostics(document);
    return;
  }

  let schemaUri: vscode.Uri | undefined = pick.uri;

  if (pick.action === 'browse') {
    const selection = await vscode.window.showOpenDialog({
      title: 'Select JSON Schema',
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { JSON: ['json', 'schema.json'] }
    });
    schemaUri = selection?.[0];
  }

  if (pick.action === 'input') {
    const input = await vscode.window.showInputBox({
      title: 'Enter schema path or URL',
      placeHolder: 'schemas/payload.schema.json or https://example.com/schema.json'
    });
    if (input) {
      schemaUri = resolveSchemaReferenceInput(document, input);
      if (!schemaUri) {
        void vscode.window.showWarningMessage('Unable to resolve that schema path or URL.');
        return;
      }
    }
  }

  if (!schemaUri) {
    return;
  }

  const reference = formatSchemaReference(document.uri, schemaUri);
  await schemaAssociationStore.setSchemaReference(document.uri, reference);
  void vscode.window.showInformationMessage(`Associated ${getDocumentName(document)} with ${schemaUri.toString()}.`);
  await refreshDiagnostics(document);
}

async function handleOpenVisualizerPanelCommand(context: vscode.ExtensionContext) {
  const revealed = VisualizerPanel.revealExisting();
  if (revealed) {
    return;
  }
  await handleVisualizerCommand(context);
}

function analyzeDocument(document: vscode.TextDocument): JsonAnalysisResult {
  return analyzeJsonText(document.getText());
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

async function handleSchemaProposalSelection(
  sampleDocument: vscode.TextDocument,
  schemaDocument: vscode.TextDocument,
  proposal: SchemaUpdateProposal
): Promise<void> {
  const action = await vscode.window.showQuickPick(['Apply Schema Update', 'View Diff', 'Cancel'], {
    placeHolder: `${proposal.title}${proposal.summary ? ' — ' + proposal.summary : ''}`,
    ignoreFocusOut: true
  });

  if (!action || action === 'Cancel') {
    return;
  }

  if (action === 'Apply Schema Update') {
    await applySchemaProposal(sampleDocument, schemaDocument, proposal);
    return;
  }

  if (action === 'View Diff') {
    await showSchemaProposalDiff(schemaDocument, proposal);
    const followup = await vscode.window.showQuickPick(['Apply Update', 'Cancel'], {
      placeHolder: `Diff opened for "${proposal.title}". Choose an action.`,
      ignoreFocusOut: true
    });
    if (followup === 'Apply Update') {
      await applySchemaProposal(sampleDocument, schemaDocument, proposal);
    }
  }
}

async function showSchemaProposalDiff(schemaDocument: vscode.TextDocument, proposal: SchemaUpdateProposal) {
  const preview = await vscode.workspace.openTextDocument({
    content: proposal.updatedSchema,
    language: schemaDocument.languageId || 'json'
  });
  const title = `${getDocumentName(schemaDocument)} ↔ ${proposal.title}`;
  await vscode.commands.executeCommand('vscode.diff', schemaDocument.uri, preview.uri, title);
}

async function applySchemaProposal(
  sampleDocument: vscode.TextDocument,
  schemaDocument: vscode.TextDocument,
  proposal: SchemaUpdateProposal
): Promise<void> {
  try {
    JSON.parse(proposal.updatedSchema);
  } catch (error) {
    void vscode.window.showErrorMessage(`Schema proposal is not valid JSON: ${String(error)}`);
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    schemaDocument.positionAt(0),
    schemaDocument.positionAt(schemaDocument.getText().length)
  );
  edit.replace(schemaDocument.uri, fullRange, proposal.updatedSchema);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage('Failed to apply schema proposal.');
    return;
  }

  const config = vscode.workspace.getConfiguration('jsonAtlas', schemaDocument.uri);
  if (config.get<boolean>('autoSaveOnEdit')) {
    await schemaDocument.save();
  }

  void vscode.window.showInformationMessage(`Applied schema proposal "${proposal.title}".`);
  log(`Applied schema proposal "${proposal.title}" to ${getDocumentName(schemaDocument)}.`);
  await refreshDiagnostics(sampleDocument);
}

async function buildSchemaQuickPickItems(document: vscode.TextDocument, currentAssignment?: string): Promise<SchemaQuickPickItem[]> {
  const candidates = await gatherSchemaCandidates(document);
  const items: SchemaQuickPickItem[] = [];
  if (currentAssignment) {
    items.push({ label: '$(trash) Clear saved association', action: 'clear' });
  }
  items.push(...candidates);
  items.push({ label: '$(folder-opened) Browse for schema file…', action: 'browse' });
  items.push({ label: '$(link-external) Enter schema URL or path…', action: 'input' });
  return items;
}

async function gatherSchemaCandidates(document: vscode.TextDocument): Promise<SchemaQuickPickItem[]> {
  const seen = new Set<string>();
  const items: SchemaQuickPickItem[] = [];

  const configEntries = await getConfiguredSchemaCandidates(document);
  for (const entry of configEntries) {
    if (!entry.uri) {
      continue;
    }
    const key = entry.uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(entry);
  }

  const workspaceEntries = await findWorkspaceSchemas(document, seen);
  items.push(...workspaceEntries);

  return items;
}

async function getConfiguredSchemaCandidates(document: vscode.TextDocument): Promise<SchemaQuickPickItem[]> {
  const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
  const mappings = config.get<Array<{ pattern?: string; schema?: string }>>('schemas', []);
  const results: SchemaQuickPickItem[] = [];
  if (Array.isArray(mappings)) {
    for (const mapping of mappings) {
      if (!mapping?.schema) {
        continue;
      }
      const uri = resolveSchemaReferenceInput(document, mapping.schema);
      if (!uri) {
        continue;
      }
      const label = mapping.schema;
      results.push({
        label,
        description: uri.scheme === 'file' ? vscode.workspace.asRelativePath(uri, false) : uri.toString(),
        uri
      });
    }
  }
  return results;
}

async function findWorkspaceSchemas(document: vscode.TextDocument, seen: Set<string>): Promise<SchemaQuickPickItem[]> {
  const results: SchemaQuickPickItem[] = [];
  const files = await vscode.workspace.findFiles('**/*.schema.json', '**/node_modules/**', 50);
  for (const uri of files) {
    const key = uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({
      label: vscode.workspace.asRelativePath(uri, false),
      description: uri.fsPath,
      uri
    });
  }
  return results;
}

function resolveSchemaReferenceInput(document: vscode.TextDocument, input: string): vscode.Uri | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      return vscode.Uri.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (nodePath.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    const segments = trimmed.replace(/^\.\/+/, '').split(/[\\/]+/).filter(Boolean);
    return vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
  }
  if (document.uri.scheme === 'file') {
    const dir = nodePath.dirname(document.uri.fsPath);
    return vscode.Uri.file(nodePath.join(dir, trimmed));
  }
  return undefined;
}

function formatSchemaReference(documentUri: vscode.Uri, schemaUri: vscode.Uri): string {
  if (schemaUri.scheme === 'file') {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) {
      const relative = nodePath.relative(workspaceFolder.uri.fsPath, schemaUri.fsPath);
      if (relative && !relative.startsWith('..')) {
        return relative.split(nodePath.sep).join('/');
      }
    }
    return schemaUri.fsPath;
  }
  return schemaUri.toString();
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
      const meta = schemaValidator.resolveSchemaForJsonPath(document.uri, path);
      const required = isPathSchemaRequired(document, path);
      result.set(encodeVisualizerPath(path), {
        pointer: target.pointer,
        uri: target.uri,
        offset: target.offset,
        length: target.length,
        title: target.title,
        description: target.description,
        required: required || undefined,
        deprecated: readSchemaBooleanFlag(meta?.schema, 'deprecated'),
        readOnly: readSchemaBooleanFlag(meta?.schema, 'readOnly'),
        writeOnly: readSchemaBooleanFlag(meta?.schema, 'writeOnly')
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

function isPathSchemaRequired(document: vscode.TextDocument, path: JsonPath): boolean {
  if (!path.length) {
    return false;
  }
  const parentPath = path.slice(0, -1);
  const lastSegment = path[path.length - 1];
  if (typeof lastSegment !== 'string') {
    return false;
  }
  const parentResolution = schemaValidator.resolveSchemaForJsonPath(document.uri, parentPath);
  if (!parentResolution) {
    return false;
  }
  return isPropertyRequiredInSchema(parentResolution.schema, lastSegment);
}

function isPropertyRequiredInSchema(schema: unknown, key: string, seen = new Set<unknown>()): boolean {
  if (!isPlainObject(schema) || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  const required = schema.required;
  if (Array.isArray(required) && required.some((entry) => entry === key)) {
    return true;
  }
  const composites = schema.allOf;
  if (Array.isArray(composites)) {
    return composites.some((candidate) => isPropertyRequiredInSchema(candidate, key, seen));
  }
  return false;
}

function readSchemaBooleanFlag(schema: unknown, key: string): boolean | undefined {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  const value = schema[key];
  return typeof value === 'boolean' ? value : undefined;
}

function buildVisualizerSchemaInsights(
  document: vscode.TextDocument,
  root: Node | undefined,
  insights: SchemaInsight[]
): VisualizerSchemaInsight[] {
  if (!root || !insights.length) {
    return [];
  }

  const result: VisualizerSchemaInsight[] = [];
  for (const insight of insights) {
    const node = findNodeAtLocation(root, insight.path);
    const startLine = node ? document.positionAt(node.offset).line : undefined;
    const endLine = node ? document.positionAt(node.offset + node.length).line : startLine;
    const pathKey = insight.path.length ? encodeVisualizerPath(insight.path) : undefined;
    result.push({
      id: insight.id,
      message: insight.message,
      severity: insight.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error',
      jsonPath: formatJsonPath(insight.path),
      pointer: insight.pointer,
      pathKey,
      startLine,
      endLine
    });
  }
  return result;
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

async function provideSchemaCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  _context: vscode.CompletionContext
): Promise<vscode.CompletionItem[] | undefined> {
  if (!isLintableDocument(document) || !isSchemaValidationEnabled(document)) {
    logSchemaCompletion(document, 'Document is not lintable or schema validation disabled.');
    return undefined;
  }

  const analysis = getOrComputeAnalysis(document);
  if (!analysis?.root) {
    logSchemaCompletion(document, 'Document failed to parse; no completion data.');
    return undefined;
  }

  const ready = await ensureSchemaNavigationData(document);
  if (!ready) {
    logSchemaCompletion(document, 'Schema navigation data unavailable (validation disabled or schema missing).');
    return undefined;
  }

  const offset = document.offsetAt(position);
  const location = getLocation(document.getText(), offset);
  if (!location) {
    logSchemaCompletion(document, 'Unable to determine JSON path for cursor.');
    return undefined;
  }

  const path = Array.isArray(location.path) ? (location.path as JsonPath).slice() : [];
  const nodeAtOffset = findNodeAtOffset(analysis.root, offset, true);
  const propertyRange =
    location.isAtPropertyKey && nodeAtOffset && nodeAtOffset.type === 'string'
      ? getStringContentRange(nodeAtOffset, document)
      : undefined;
  const isStringValueNode = !location.isAtPropertyKey && nodeAtOffset?.type === 'string';
  const valueRange =
    !location.isAtPropertyKey && nodeAtOffset
      ? isStringValueNode
        ? getStringContentRange(nodeAtOffset, document)
        : new vscode.Range(document.positionAt(nodeAtOffset.offset), document.positionAt(nodeAtOffset.offset + nodeAtOffset.length))
      : undefined;

  const completions: vscode.CompletionItem[] = [];

  if (location.isAtPropertyKey) {
    const objectPath = path.slice(0, -1) as JsonPath;
    completions.push(...buildSchemaPropertyCompletions(document, analysis.root, objectPath, propertyRange));
    const requiredSnippet = buildRequiredPropertiesSnippet(document, analysis.root, objectPath, propertyRange, position);
    if (requiredSnippet) {
      completions.push(requiredSnippet);
    }
  } else {
    completions.push(...buildEnumValueCompletions(document, path, valueRange, { withinStringLiteral: isStringValueNode }));
  }

  if (!completions.length) {
    logSchemaCompletion(
      document,
      `No schema completions for path ${formatJsonPath(path)} (isAtPropertyKey=${Boolean(location.isAtPropertyKey)})`
    );
  } else {
    logSchemaCompletion(
      document,
      `Provided ${completions.length} schema completions for ${location.isAtPropertyKey ? 'property' : 'value'} path ${formatJsonPath(path)}`
    );
  }

  return completions.length ? completions : undefined;
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

async function provideSchemaCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
  if (!isLintableDocument(document) || !isSchemaValidationEnabled(document)) {
    return [];
  }

  const analysis = getOrComputeAnalysis(document);
  if (!analysis?.root) {
    return [];
  }

  const ready = await ensureSchemaNavigationData(document);
  if (!ready) {
    return [];
  }

  const pointerMap = schemaPointerCache.get(document.uri.toString());
  if (!pointerMap || !pointerMap.size) {
    return [];
  }

  return buildSchemaCodeLenses(document, analysis.root, pointerMap);
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

function shouldDisplayInsights(document: vscode.TextDocument): boolean {
  if (!isLintableDocument(document)) {
    return false;
  }
  if (document.uri.scheme !== 'file') {
    return false;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
  const patterns = config.get<string[]>('insightExcludeGlobs', ['**/.vscode/**', '**/*.schema.json']);
  if (!Array.isArray(patterns) || !patterns.length) {
    return true;
  }

  const relative = vscode.workspace.asRelativePath(document.uri, false);
  return !patterns.some((pattern) => minimatch(relative, pattern, { nocase: true, dot: true, matchBase: true }));
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

function buildSchemaCodeLenses(
  document: vscode.TextDocument,
  root: Node,
  pointerMap: Map<string, VisualizerSchemaPointerEntry>
): vscode.CodeLens[] {
  const lenses: vscode.CodeLens[] = [];

  const visit = (node: Node, path: JsonPath) => {
    if (node.type === 'object' || node.type === 'array') {
      const key = encodeVisualizerPath(path);
      const entry = pointerMap.get(key);
      if (entry) {
        const schemaTitle = entry.title?.trim();
        const lensTitle = schemaTitle ? `Schema · ${schemaTitle}` : 'Schema definition';
        const start = document.positionAt(node.offset);
        const range = new vscode.Range(start, start);
        const commandArgs: GoToSchemaDefinitionCommandArgs = {
          documentUri: document.uri.toString(),
          path: path.slice()
        };
        lenses.push(
          new vscode.CodeLens(range, {
            title: lensTitle,
            tooltip: entry.description || entry.pointer || 'Open schema definition',
            command: 'jsonAtlas.goToSchemaDefinition',
            arguments: [commandArgs]
          })
        );
      }
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
  return lenses;
}

function buildSchemaPropertyCompletions(
  document: vscode.TextDocument,
  root: Node | undefined,
  objectPath: JsonPath,
  replaceRange?: vscode.Range
): vscode.CompletionItem[] {
  if (!root) {
    return [];
  }

  const resolution = schemaValidator.resolveSchemaForJsonPath(document.uri, objectPath);
  if (!resolution || !isPlainObject(resolution.schema)) {
    return [];
  }

  const properties = collectSchemaPropertyEntries(resolution.schema);
  if (!properties.length) {
    return [];
  }

  const objectNode = findNodeAtLocation(root, objectPath);
  const existingKeys = collectObjectPropertyKeys(objectNode);
  const requiredSet = new Set(collectRequiredProperties(resolution.schema));
  const completions: vscode.CompletionItem[] = [];

  for (const entry of properties) {
    const propertyPath = objectPath.concat([entry.name]);
    const resolved = schemaValidator.resolveSchemaForJsonPath(document.uri, propertyPath);
    const propertySchema = resolved?.schema ?? entry.schema;
    const description = readSchemaDescription(propertySchema);
    const defaultValue = readSchemaDefault(propertySchema);
    const pointer = resolved?.pointer;
    const typeLabel = getPrimarySchemaType(propertySchema);
    const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Property);
    if (replaceRange) {
      item.range = replaceRange;
      item.insertText = entry.name;
    } else {
      item.insertText = `"${entry.name}"`;
    }
    const detailParts: string[] = [];
    if (requiredSet.has(entry.name)) {
      detailParts.push('required');
    }
    if (typeLabel) {
      detailParts.push(typeLabel);
    }
    if (typeof defaultValue !== 'undefined') {
      detailParts.push(`default: ${formatDefaultPreview(defaultValue)}`);
    }
    if (existingKeys.has(entry.name)) {
      detailParts.push('already set');
    }
    if (detailParts.length) {
      item.detail = detailParts.join(' · ');
    }
    const markdown = buildPropertyCompletionMarkdown(description, defaultValue, pointer);
    if (markdown) {
      item.documentation = markdown;
    }
    item.sortText = `${requiredSet.has(entry.name) ? '1' : '2'}_${entry.name}`;
    completions.push(item);
  }

  return completions;
}

interface EnumCompletionOptions {
  withinStringLiteral?: boolean;
}

function buildEnumValueCompletions(
  document: vscode.TextDocument,
  path: JsonPath,
  replaceRange?: vscode.Range,
  options?: EnumCompletionOptions
): vscode.CompletionItem[] {
  const resolution = schemaValidator.resolveSchemaForJsonPath(document.uri, path);
  if (!resolution) {
    return [];
  }

  const enumValues = readEnumValues(resolution.schema);
  if (!enumValues?.length) {
    return [];
  }

  const description = readSchemaDescription(resolution.schema);
  const defaultValue = readSchemaDefault(resolution.schema);
  const completions: vscode.CompletionItem[] = [];

  enumValues.forEach((value, index) => {
    const label = typeof value === 'string' ? value : formatDefaultPreview(value);
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
    const insertText = formatJsonValue(value);
    if (options?.withinStringLiteral && typeof value === 'string') {
      item.insertText = value;
    } else {
      item.insertText = insertText;
    }
    if (replaceRange) {
      item.range = replaceRange;
    }
    const detailParts: string[] = ['enum value'];
    const typeLabel = typeof value;
    if (typeLabel !== 'undefined' && typeLabel !== 'object') {
      detailParts.push(typeLabel);
    } else if (Array.isArray(value)) {
      detailParts.push('array');
    } else if (value === null) {
      detailParts.push('null');
    } else if (value && typeof value === 'object') {
      detailParts.push('object');
    }
    if (typeof defaultValue !== 'undefined' && valuesEqual(defaultValue, value)) {
      detailParts.push('default');
    }
    item.detail = detailParts.join(' · ');
    const markdown = buildEnumCompletionMarkdown(description, value, resolution.pointer, defaultValue);
    if (markdown) {
      item.documentation = markdown;
    }
    item.sortText = `3_${index.toString().padStart(2, '0')}`;
    completions.push(item);
  });

  return completions;
}

function buildRequiredPropertiesSnippet(
  document: vscode.TextDocument,
  root: Node | undefined,
  objectPath: JsonPath,
  replaceRange: vscode.Range | undefined,
  position: vscode.Position
): vscode.CompletionItem | undefined {
  if (!root) {
    return undefined;
  }
  const resolution = schemaValidator.resolveSchemaForJsonPath(document.uri, objectPath);
  if (!resolution || !isPlainObject(resolution.schema)) {
    return undefined;
  }
  const required = collectRequiredProperties(resolution.schema);
  if (!required.length) {
    return undefined;
  }
  const objectNode = findNodeAtLocation(root, objectPath);
  const existingKeys = collectObjectPropertyKeys(objectNode);
  const missing = required.filter((name) => !existingKeys.has(name));
  if (!missing.length) {
    return undefined;
  }

  const lineIndent = getLineIndentation(document, position);
  const snippet = new vscode.SnippetString();
  missing.forEach((name, index) => {
    if (index > 0) {
      snippet.appendText(',\n');
    }
    snippet.appendText(`${lineIndent}"${name}": `);
    appendValueSnippetForSchema(snippet, document.uri, objectPath.concat([name]));
  });

  const item = new vscode.CompletionItem('Insert required properties', vscode.CompletionItemKind.Snippet);
  item.insertText = snippet;
  if (replaceRange) {
    item.range = replaceRange;
  }
  item.sortText = '0_required';
  const propertyList = missing.map((name) => `\`${escapeMarkdown(name)}\``).join(', ');
  item.detail = `JSON Schema · ${missing.length} required ${missing.length === 1 ? 'property' : 'properties'}`;
  item.documentation = new vscode.MarkdownString(
    `Adds the missing required properties: ${propertyList}`
  );
  return item;
}

interface SchemaPropertyEntry {
  name: string;
  schema: unknown;
}

function collectSchemaPropertyEntries(schema: unknown): SchemaPropertyEntry[] {
  if (!isPlainObject(schema)) {
    return [];
  }
  const result = new Map<string, unknown>();
  const visited = new Set<unknown>();
  const visit = (candidate: unknown) => {
    if (!isPlainObject(candidate) || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    const properties = candidate.properties;
    if (isPlainObject(properties)) {
      for (const [name, value] of Object.entries(properties)) {
        if (!result.has(name)) {
          result.set(name, value);
        }
      }
    }
    const composites = [candidate.allOf, candidate.anyOf, candidate.oneOf];
    for (const block of composites) {
      if (Array.isArray(block)) {
        block.forEach(visit);
      }
    }
  };
  visit(schema);
  return Array.from(result.entries()).map(([name, value]) => ({ name, schema: value }));
}

function collectRequiredProperties(schema: unknown): string[] {
  if (!isPlainObject(schema)) {
    return [];
  }
  const required = new Set<string>();
  const visited = new Set<unknown>();
  const visit = (candidate: unknown) => {
    if (!isPlainObject(candidate) || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate.required)) {
      for (const prop of candidate.required) {
        if (typeof prop === 'string') {
          required.add(prop);
        }
      }
    }
    if (Array.isArray(candidate.allOf)) {
      candidate.allOf.forEach(visit);
    }
  };
  visit(schema);
  return Array.from(required.values());
}

function collectObjectPropertyKeys(node: Node | undefined): Set<string> {
  const keys = new Set<string>();
  if (!node || node.type !== 'object') {
    return keys;
  }
  for (const property of node.children ?? []) {
    if (property.type !== 'property' || !property.children || property.children.length < 2) {
      continue;
    }
    const keyNode = property.children[0];
    const key = extractPropertyKey(keyNode);
    if (typeof key !== 'undefined') {
      keys.add(key);
    }
  }
  return keys;
}

function getLineIndentation(document: vscode.TextDocument, position: vscode.Position): string {
  const line = document.lineAt(position.line);
  const match = line.text.match(/^\s*/);
  return match ? match[0] : '';
}

function appendValueSnippetForSchema(snippet: vscode.SnippetString, uri: vscode.Uri, path: JsonPath) {
  const resolved = schemaValidator.resolveSchemaForJsonPath(uri, path);
  const schema = resolved?.schema;
  const defaultValue = readSchemaDefault(schema);
  if (typeof defaultValue !== 'undefined') {
    snippet.appendText(formatJsonValue(defaultValue));
    return;
  }
  const type = getPrimarySchemaType(schema);
  if (type === 'string') {
    snippet.appendText('"');
    snippet.appendPlaceholder('value');
    snippet.appendText('"');
    return;
  }
  if (type === 'number' || type === 'integer') {
    snippet.appendPlaceholder('0');
    return;
  }
  if (type === 'boolean') {
    snippet.appendChoice(['true', 'false']);
    return;
  }
  if (type === 'array') {
    snippet.appendText('[');
    snippet.appendPlaceholder('items');
    snippet.appendText(']');
    return;
  }
  if (type === 'object') {
    snippet.appendText('{ ');
    snippet.appendPlaceholder('…');
    snippet.appendText(' }');
    return;
  }
  snippet.appendPlaceholder('value');
}

function readSchemaDescription(schema: unknown): string | undefined {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  const description = schema.description;
  return typeof description === 'string' ? description : undefined;
}

function readSchemaDefault(schema: unknown): unknown {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
    return schema.default;
  }
  return undefined;
}

function getPrimarySchemaType(schema: unknown): string | undefined {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  const typeValue = schema.type;
  if (typeof typeValue === 'string') {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const first = typeValue.find((value) => typeof value === 'string');
    return typeof first === 'string' ? first : undefined;
  }
  if (readEnumValues(schema)?.length) {
    const sample = readEnumValues(schema) ?? [];
    const firstValue = sample.find((value) => value !== undefined);
    if (typeof firstValue === 'string') {
      return 'string';
    }
    if (typeof firstValue === 'number') {
      return 'number';
    }
    if (typeof firstValue === 'boolean') {
      return 'boolean';
    }
  }
  return undefined;
}

function formatDefaultPreview(value: unknown): string {
  const raw = formatJsonValue(value).replace(/\s+/g, ' ').trim();
  return truncate(raw, 40);
}

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

function buildPropertyCompletionMarkdown(
  description: string | undefined,
  defaultValue: unknown,
  pointer?: string
): vscode.MarkdownString | undefined {
  if (!description && typeof defaultValue === 'undefined' && !pointer) {
    return undefined;
  }
  const markdown = new vscode.MarkdownString(undefined, true);
  if (description) {
    markdown.appendMarkdown(`${escapeMarkdown(description)}\n\n`);
  }
  if (typeof defaultValue !== 'undefined') {
    markdown.appendMarkdown(`Default: ${formatValueForMarkdown(formatJsonValue(defaultValue))}\n\n`);
  }
  if (pointer) {
    markdown.appendMarkdown(`Schema pointer: \`${escapeMarkdown(pointer)}\``);
  }
  return markdown;
}

function buildEnumCompletionMarkdown(
  description: string | undefined,
  value: unknown,
  pointer: string | undefined,
  defaultValue: unknown
): vscode.MarkdownString | undefined {
  const pieces: string[] = [];
  if (description) {
    pieces.push(escapeMarkdown(description));
  }
  const valueText = formatJsonValue(value);
  pieces.push(`Value: ${formatValueForMarkdown(valueText)}`);
  if (typeof defaultValue !== 'undefined' && valuesEqual(defaultValue, value)) {
    pieces.push('Matches the schema default.');
  }
  if (pointer) {
    pieces.push(`Pointer: \`${escapeMarkdown(pointer)}\``);
  }
  if (!pieces.length) {
    return undefined;
  }
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(pieces.join('\n\n'));
  return markdown;
}

function formatValueForMarkdown(value: string): string {
  if (value.includes('\n')) {
    return `\n\n\`\`\`json\n${value}\n\`\`\``;
  }
  return `\`${escapeMarkdown(value)}\``;
}

function readEnumValues(schema: unknown): unknown[] | undefined {
  if (!isPlainObject(schema)) {
    return undefined;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return [schema.const];
  }
  return undefined;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringContentRange(node: Node, document: vscode.TextDocument): vscode.Range {
  if (node.type !== 'string') {
    return new vscode.Range(document.positionAt(node.offset), document.positionAt(node.offset + node.length));
  }
  const startOffset = node.length >= 1 ? node.offset + 1 : node.offset;
  const endOffset = node.length >= 2 ? node.offset + node.length - 1 : node.offset + node.length;
  const start = document.positionAt(startOffset);
  const end = document.positionAt(Math.max(endOffset, startOffset));
  return new vscode.Range(start, end);
}

function log(message: string) {
  if (!outputChannel) {
    return;
  }
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logSchemaCompletion(document: vscode.TextDocument, message: string) {
  log(`[completion:${getDocumentName(document)}] ${message}`);
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
