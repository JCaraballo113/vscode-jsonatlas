import * as vscode from 'vscode';
import { Segment, visit } from 'jsonc-parser';
import { AiService } from './aiService';
import { CoreMessage } from 'ai';

const renameParseOptions = {
    allowTrailingComma: true,
    disallowComments: false,
};

export interface VisualizerSelectionInfo {
    active: boolean;
    summary?: string;
    startLine?: number;
    endLine?: number;
}

interface VisualizerUpdateOptions {
    documentUri?: vscode.Uri;
    reveal?: boolean;
    selection?: VisualizerSelectionInfo;
    focusRoot?: boolean;
    resetLayout?: boolean;
}

// Renders JSON content as a lightweight visualizer inside a VS Code webview.
export class VisualizerPanel {
    private static currentPanel: VisualizerPanel | undefined;

  public static render(
    extensionUri: vscode.Uri,
    data: unknown,
    documentUri: vscode.Uri,
    aiService: AiService,
    selection?: VisualizerSelectionInfo
  ) {
        if (VisualizerPanel.currentPanel) {
            VisualizerPanel.currentPanel.update(data, {
                documentUri,
                reveal: true,
                selection,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'jsonAtlasVisualizer',
            'JSON Atlas Visualizer',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                ],
            }
        );

        VisualizerPanel.currentPanel = new VisualizerPanel(
            panel,
            extensionUri,
            data,
            documentUri,
            aiService,
            selection
        );
    }

    public static updateIfActive(
        documentUri: vscode.Uri,
        data: unknown,
        selection?: VisualizerSelectionInfo,
        options?: VisualizerUpdateOptions
    ) {
        if (VisualizerPanel.currentPanel?.isForDocument(documentUri)) {
            VisualizerPanel.currentPanel.update(data, {
                reveal: false,
                selection,
                focusRoot: options?.focusRoot,
            });
        }
    }

    public static updateSelection(
        documentUri: vscode.Uri,
        selection?: VisualizerSelectionInfo
    ) {
        if (!VisualizerPanel.currentPanel?.isForDocument(documentUri)) {
            return;
        }
        VisualizerPanel.currentPanel.applySelectionUpdate(selection);
    }

    public static focusRoot(documentUri: vscode.Uri) {
        if (!VisualizerPanel.currentPanel?.isForDocument(documentUri)) {
            return;
        }
        VisualizerPanel.currentPanel.triggerFocusRoot();
    }

    public static focusPath(documentUri: vscode.Uri, path: string) {
        if (!VisualizerPanel.currentPanel?.isForDocument(documentUri)) {
            return;
        }
        VisualizerPanel.currentPanel.queueFocusPath(path);
    }

    public static revealExisting() {
        if (!VisualizerPanel.currentPanel) {
            return false;
        }
        VisualizerPanel.currentPanel.panel.reveal(
            vscode.ViewColumn.Beside,
            true
        );
        return true;
    }

    public static notifyInvalid(documentUri: vscode.Uri, message: string) {
        if (VisualizerPanel.currentPanel?.isForDocument(documentUri)) {
            VisualizerPanel.currentPanel.showInvalid(message);
        }
    }

    public static isDocumentActive(documentUri: vscode.Uri) {
        return (
            VisualizerPanel.currentPanel?.isForDocument(documentUri) ?? false
        );
    }

    public static refreshConfiguration() {
        VisualizerPanel.currentPanel?.refresh();
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly ai: AiService;
    private readonly disposables: vscode.Disposable[] = [];
    private documentUri: vscode.Uri;
    private data: unknown;
    private selectionInfo: VisualizerSelectionInfo | undefined;
    private isWebviewReady = false;
    private pendingInvalidMessage: string | undefined;
    private pendingResetView = false;
    private pendingFocusRoot = false;
    private pendingFocusPath: string | undefined;
    private readonly chatSessions = new Map<string, CoreMessage[]>();
    private chatMessageCounter = 0;
    private pendingResetLayout = false;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        data: unknown,
        documentUri: vscode.Uri,
        aiService: AiService,
        selection?: VisualizerSelectionInfo
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.data = data;
        this.documentUri = documentUri;
        this.ai = aiService;
        this.selectionInfo = selection;

        this.disposables.push(
            this.ai.onModelChanged(() => {
                this.postChatModelConfig();
                void this.postAiStatus();
            })
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message) => {
                if (message?.type === 'ready') {
                    this.isWebviewReady = true;
                    this.postData();
                    this.postInvalidMessage();
                    this.postChatHistory();
                    this.flushPendingFocusPath();
                    return;
                }

                if (
                    message?.type === 'openLink' &&
                    typeof message.payload === 'string'
                ) {
                    void vscode.env.openExternal(
                        vscode.Uri.parse(message.payload)
                    );
                    return;
                }

                if (message?.type === 'requestRename') {
                    void this.promptRename(message.payload);
                    return;
                }

                if (message?.type === 'requestEditValue') {
                    void this.promptEditValue(message.payload);
                    return;
                }

                if (message?.type === 'chat:ensureKey') {
                    void this.ensureChatReady();
                    return;
                }

                if (message?.type === 'chat:send') {
                    void this.handleChatSend(message.payload);
                    return;
                }

                if (message?.type === 'chat:reset') {
                    this.resetChat();
                    return;
                }

                if (message?.type === 'chat:setModel') {
                    void this.handleChatSetModel(message.payload);
                    return;
                }

                if (message?.type === 'chat:applySnippet') {
                    void this.applySnippet(message.payload);
                    return;
                }

                if (message?.type === 'selection:applyLines') {
                    void this.applyLineSelection(
                        this.parseSelectionLines(message.payload)
                    );
                    return;
                }

                if (message?.type === 'selection:clear') {
                    void this.applyLineSelection();
                    return;
                }
            },
            null,
            this.disposables
        );

        this.panel.webview.html = this.getHtmlForWebview();
    }

    public update(
        data: unknown,
        options: VisualizerUpdateOptions = {}
    ) {
        this.data = data;
        this.pendingInvalidMessage = undefined;
        this.selectionInfo = options.selection;
        if (options.focusRoot) {
            this.pendingResetView = true;
            this.pendingFocusRoot = true;
        }
        if (options.resetLayout) {
            this.pendingResetLayout = true;
        }

        if (options.documentUri) {
            this.documentUri = options.documentUri;
        }

        if (this.isWebviewReady) {
            this.postData();
        }

        if (options.reveal !== false) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
        }
    }

    public dispose() {
        VisualizerPanel.currentPanel = undefined;

        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            try {
                disposable?.dispose();
            } catch {
                // no-op
            }
        }
    }

    private postData() {
        if (!this.isWebviewReady) {
            return;
        }

        const defaultViewMode = this.getPreferredViewMode();
        const graphScale = this.getGraphScalePreferences();
        const graphDepth = this.getGraphDepthPreference();

        this.panel.webview.postMessage({
            type: 'render',
            payload: {
                data: this.data,
                documentId: this.documentUri.toString(),
                defaultViewMode,
                graphAutoScale: graphScale.auto,
                graphInitialScale: graphScale.scale,
                graphMaxDepth:
                    typeof graphDepth === 'number' ? graphDepth : null,
                selectionInfo: this.selectionInfo,
                resetView: this.consumeResetViewFlag(),
                focusRoot: this.consumeFocusRootFlag(),
                resetLayout: this.consumeResetLayoutFlag(),
            },
        });
        this.postChatHistory();
        void this.postAiStatus();
        this.postChatModelConfig();
        this.flushPendingFocusPath();
    }

    private postInvalidMessage() {
        if (!this.isWebviewReady || !this.pendingInvalidMessage) {
            return;
        }

        this.panel.webview.postMessage({
            type: 'invalid',
            payload: this.pendingInvalidMessage,
        });
    }

    private refresh() {
        this.postData();
    }

    private consumeResetViewFlag(): boolean {
        const flag = this.pendingResetView;
        this.pendingResetView = false;
        return flag;
    }

    private consumeFocusRootFlag(): boolean {
        const flag = this.pendingFocusRoot;
        this.pendingFocusRoot = false;
        return flag;
    }

    private consumeResetLayoutFlag(): boolean {
        const flag = this.pendingResetLayout;
        this.pendingResetLayout = false;
        return flag;
    }

    private applySelectionUpdate(selection?: VisualizerSelectionInfo) {
        this.selectionInfo = selection;
        if (!this.isWebviewReady) {
            return;
        }
        this.panel.webview.postMessage({
            type: 'selection:update',
            payload: selection,
        });
    }

    private triggerFocusRoot() {
        this.pendingResetView = true;
        this.pendingFocusRoot = true;
        if (this.isWebviewReady) {
            this.postData();
        }
    }

    private queueFocusPath(path: string) {
        this.pendingFocusPath = path;
        if (this.isWebviewReady) {
            this.flushPendingFocusPath();
        }
    }

    private flushPendingFocusPath() {
        if (!this.pendingFocusPath || !this.isWebviewReady) {
            return;
        }
        this.panel.webview.postMessage({ type: 'visualizer:focusPath', payload: this.pendingFocusPath });
        this.pendingFocusPath = undefined;
    }

    private async postAiStatus() {
        if (!this.isWebviewReady) {
            return;
        }

        const selected = this.ai.getSelectedModelOption();
        const hasKey = await this.ai.hasApiKey(selected.provider);
        this.panel.webview.postMessage({
            type: 'chat:aiStatus',
            payload: { hasKey, provider: selected.provider },
        });
    }

    private postChatModelConfig() {
        if (!this.isWebviewReady) {
            return;
        }

        const selected = this.ai.getSelectedModelOption();
        const options = this.ai
            .getModelOptions()
            .map((option) => ({
                id: option.id,
                label: option.label,
                description: option.description,
            }));

        this.panel.webview.postMessage({
            type: 'chat:modelOptions',
            payload: {
                selectedId: selected.id,
                selectedProvider: selected.provider,
                options,
            },
        });
    }

    private showInvalid(message: string) {
        this.pendingInvalidMessage = message;
        if (this.isWebviewReady) {
            this.postInvalidMessage();
        }
    }

    private async handleChatSend(payload: unknown) {
        const candidate = payload as { text?: string } | undefined;
        const text =
            typeof candidate?.text === 'string' ? candidate.text.trim() : '';
        if (!text) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(
            this.documentUri
        );
        const sessionId = this.documentUri.toString();
        const history = this.chatSessions.get(sessionId) ?? [];
        const userMessageId = this.nextMessageId('user');
        const assistantMessageId = this.nextMessageId('assistant');

        this.panel.webview.postMessage({
            type: 'chat:userMessage',
            payload: { id: userMessageId, text },
        });
        this.panel.webview.postMessage({
            type: 'chat:assistantStart',
            payload: { id: assistantMessageId },
        });

        const result = await this.ai.streamChat({
            document,
            history,
            prompt: text,
            callbacks: {
                onStart: () =>
                    this.panel.webview.postMessage({
                        type: 'chat:status',
                        payload: { state: 'thinking' },
                    }),
                onDelta: (delta) =>
                    this.panel.webview.postMessage({
                        type: 'chat:assistantDelta',
                        payload: { id: assistantMessageId, text: delta },
                    }),
                onComplete: (full) =>
                    this.handleChatComplete(assistantMessageId, full),
                onError: (error) =>
                    this.panel.webview.postMessage({
                        type: 'chat:error',
                        payload: describeError(error),
                    }),
            },
        });

        if (result.error) {
            if ((result.error as Error).message === 'missing_api_key') {
                this.panel.webview.postMessage({ type: 'chat:needsApiKey' });
            }
            this.panel.webview.postMessage({
                type: 'chat:status',
                payload: { state: 'idle' },
            });
            return;
        }

        if (result.text) {
            const updatedHistory = [
                ...history,
                createChatMessage('user', text),
                createChatMessage('assistant', result.text),
            ];
            this.chatSessions.set(sessionId, this.trimHistory(updatedHistory));
        }

        this.panel.webview.postMessage({
            type: 'chat:status',
            payload: { state: 'idle' },
        });
    }

    private async handleChatSetModel(payload: unknown) {
        if (!payload || typeof payload !== 'object') {
            return;
        }

        const { modelId } = payload as { modelId?: string };
        if (typeof modelId !== 'string' || !modelId.trim()) {
            return;
        }

        const applied = await this.ai.setSelectedModel(modelId);
        if (!applied) {
            return;
        }

        this.postChatModelConfig();
        await this.postAiStatus();
    }

    private handleChatComplete(messageId: string, fullText: string) {
        const snippet = extractJsonSnippet(fullText);
        this.panel.webview.postMessage({
            type: 'chat:assistantComplete',
            payload: { id: messageId, text: fullText, snippet },
        });
    }

    private resetChat() {
        const sessionId = this.documentUri.toString();
        this.chatSessions.delete(sessionId);
        this.postChatHistory();
    }

    private async applySnippet(payload: unknown) {
        if (!payload || typeof payload !== 'object') {
            return;
        }

        const { content } = payload as { content?: string };
        if (!content) {
            return;
        }

        try {
            JSON.parse(content);
        } catch {
            void vscode.window.showErrorMessage(
                'AI suggestion is not valid JSON.'
            );
            return;
        }

        const document = await vscode.workspace.openTextDocument(
            this.documentUri
        );
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, content);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            void vscode.window.showErrorMessage(
                'Failed to apply AI suggestion.'
            );
            return;
        }

        const config = vscode.workspace.getConfiguration(
            'jsonAtlas',
            document.uri
        );
        if (config.get<boolean>('autoSaveOnEdit')) {
            await document.save();
        }

        void vscode.window.showInformationMessage(
            'AI suggestion applied to the document.'
        );
    }

    private postChatHistory() {
        if (!this.isWebviewReady) {
            return;
        }
        const sessionId = this.documentUri.toString();
        const history = this.chatSessions.get(sessionId) ?? [];
        const serialized = history.map((message, index) => ({
            id: `history-${index}`,
            role: message.role,
            text: formatMessageContent(message.content),
        }));
        this.panel.webview.postMessage({
            type: 'chat:history',
            payload: serialized,
        });
    }

    private trimHistory(messages: CoreMessage[], max = 12): CoreMessage[] {
        return messages.slice(-max);
    }

    private nextMessageId(prefix: string) {
        this.chatMessageCounter += 1;
        return `${prefix}-${this.chatMessageCounter}`;
    }

    private async ensureChatReady() {
        const key = await this.ai.ensureApiKey();
        this.panel.webview.postMessage({
            type: 'chat:ensureKeyResult',
            payload: { ready: Boolean(key) },
        });
        if (!key) {
            void vscode.window.showWarningMessage(
                'No AI API key configured. Run JSON Atlas: Set AI API Key.'
            );
        }
        void this.postAiStatus();
    }

    private async promptRename(payload: unknown) {
        const request = this.parseRenamePayload(payload);
        if (!request) {
            return;
        }

        const proposed = await vscode.window.showInputBox({
            title: 'Rename JSON key',
            prompt: 'Enter a new property name',
            value: request.currentName,
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim().length
                    ? undefined
                    : 'Key name cannot be empty.';
            },
        });

        if (typeof proposed === 'undefined') {
            return;
        }

        const trimmed = proposed.trim();
        if (!trimmed || trimmed === request.currentName) {
            return;
        }

        await this.renameKey(request.path, trimmed);
    }

    private async renameKey(path: string, newName: string) {
        const segments = this.parsePathSegments(path);
        if (!segments) {
            return;
        }

        if (
            !segments.length ||
            typeof segments[segments.length - 1] !== 'string'
        ) {
            void vscode.window.showErrorMessage(
                'Only object properties can be renamed.'
            );
            return;
        }

        const propertyName = String(segments[segments.length - 1]);
        const parentPath = segments.slice(0, -1);
        const arrayAncestor =
            parentPath.length &&
            typeof parentPath[parentPath.length - 1] === 'number'
                ? parentPath.slice(0, -1)
                : undefined;

        try {
            const document = await vscode.workspace.openTextDocument(
                this.documentUri
            );
            const config = vscode.workspace.getConfiguration(
                'jsonAtlas',
                document.uri
            );
            const autoSave = config.get<boolean>('autoSaveOnEdit');
            const targets = findPropertyKeyRanges(
                document.getText(),
                propertyName,
                segments,
                arrayAncestor
            );
            if (!targets.length) {
                void vscode.window.showErrorMessage(
                    'Unable to locate the selected key.'
                );
                return;
            }

            const replacement = JSON.stringify(newName);
            const edit = new vscode.WorkspaceEdit();
            targets.forEach((target) => {
                const range = new vscode.Range(
                    document.positionAt(target.offset),
                    document.positionAt(target.offset + target.length)
                );
                edit.replace(document.uri, range, replacement);
            });
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                void vscode.window.showErrorMessage('Failed to rename key.');
                return;
            }

            if (autoSave) {
                const saved = await document.save();
                if (!saved) {
                    void vscode.window.showWarningMessage(
                        'Rename applied but the document could not be saved automatically.'
                    );
                }
            }
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Rename failed: ${String(error)}`
            );
        }
    }

    private async promptEditValue(payload: unknown) {
        const request = this.parseEditValuePayload(payload);
        if (!request) {
            return;
        }

        const label = request.kind
            ? request.kind.charAt(0).toUpperCase() + request.kind.slice(1)
            : 'JSON';
        const proposed = await vscode.window.showInputBox({
            title: `Edit ${label} value`,
            prompt: 'Enter a JSON literal for the new value (wrap strings in double quotes).',
            value: request.literal,
            ignoreFocusOut: true,
            validateInput: (value) => this.validateLiteralInput(value),
        });

        if (typeof proposed === 'undefined') {
            return;
        }

        const trimmed = proposed.trim();
        if (!trimmed || trimmed === request.literal.trim()) {
            return;
        }

        await this.editValue(request.path, trimmed);
    }

    private async editValue(path: string, literal: string) {
        const segments = this.parsePathSegments(path);
        if (!segments) {
            return;
        }

        try {
            JSON.parse(literal);
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Enter a valid JSON literal (wrap strings in double quotes). Reason: ${describeError(
                    error
                )}`
            );
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(
                this.documentUri
            );
            const config = vscode.workspace.getConfiguration(
                'jsonAtlas',
                document.uri
            );
            const autoSave = config.get<boolean>('autoSaveOnEdit');
            const targets = findValueRanges(document.getText(), segments);
            if (!targets.length) {
                void vscode.window.showErrorMessage(
                    'Unable to locate the selected value.'
                );
                return;
            }

            const edit = new vscode.WorkspaceEdit();
            targets.forEach((target) => {
                const range = new vscode.Range(
                    document.positionAt(target.offset),
                    document.positionAt(target.offset + target.length)
                );
                edit.replace(document.uri, range, literal);
            });

            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                void vscode.window.showErrorMessage('Failed to update value.');
                return;
            }

            if (autoSave) {
                const saved = await document.save();
                if (!saved) {
                    void vscode.window.showWarningMessage(
                        'Value updated but the document could not be saved automatically.'
                    );
                }
            }
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Value edit failed: ${String(error)}`
            );
        }
    }

    private isForDocument(documentUri: vscode.Uri): boolean {
        return this.documentUri.toString() === documentUri.toString();
    }

    private parseRenamePayload(
        payload: unknown
    ): { path: string; currentName: string } | undefined {
        if (!payload || typeof payload !== 'object') {
            return undefined;
        }

        const { path, currentName } = payload as {
            path?: string;
            currentName?: string;
        };
        if (typeof path !== 'string' || !path) {
            return undefined;
        }

        return {
            path,
            currentName: typeof currentName === 'string' ? currentName : '',
        };
    }

    private parseEditValuePayload(
        payload: unknown
    ): { path: string; literal: string; kind?: string } | undefined {
        if (!payload || typeof payload !== 'object') {
            return undefined;
        }

        const { path, literal, kind } = payload as {
            path?: string;
            literal?: string;
            kind?: string;
        };
        if (typeof path !== 'string' || !path) {
            return undefined;
        }

        if (typeof literal !== 'string' || !literal.trim().length) {
            return undefined;
        }

        return {
            path,
            literal: literal.trim(),
            kind: typeof kind === 'string' ? kind : undefined,
        };
    }

    private parseSelectionLines(
        payload: unknown
    ): { startLine: number; endLine: number } | undefined {
        if (!payload || typeof payload !== 'object') {
            void vscode.window.showWarningMessage(
                'Enter valid line numbers to apply a selection.'
            );
            return undefined;
        }

        const { startLine, endLine } = payload as {
            startLine?: number;
            endLine?: number;
        };
        if (typeof startLine !== 'number' || typeof endLine !== 'number') {
            void vscode.window.showWarningMessage(
                'Enter both start and end line numbers to apply a selection.'
            );
            return undefined;
        }

        const normalizedStart = Math.floor(startLine);
        const normalizedEnd = Math.floor(endLine);
        if (
            !Number.isFinite(normalizedStart) ||
            !Number.isFinite(normalizedEnd) ||
            normalizedStart <= 0 ||
            normalizedEnd <= 0
        ) {
            void vscode.window.showWarningMessage(
                'Line numbers must be positive.'
            );
            return undefined;
        }

        return {
            startLine: normalizedStart,
            endLine: normalizedEnd,
        };
    }

    private validateLiteralInput(value: string) {
        if (typeof value !== 'string' || !value.trim().length) {
            return 'Value cannot be empty.';
        }

        try {
            JSON.parse(value);
            return undefined;
        } catch {
            return 'Enter a valid JSON literal (wrap strings in double quotes).';
        }
    }

    private parsePathSegments(path: string): Segment[] | undefined {
        try {
            const parsed = JSON.parse(path);
            if (!Array.isArray(parsed)) {
                throw new Error('Path must be an array.');
            }
            return parsed as Segment[];
        } catch (error) {
            void vscode.window.showErrorMessage(
                `Unable to rename key: ${String(error)}`
            );
            return undefined;
        }
    }

    private async applyLineSelection(range?: {
        startLine: number;
        endLine: number;
    }) {
        const editor = this.findEditorForDocument();
        if (!editor) {
            void vscode.window.showWarningMessage(
                'Open the JSON document to adjust the selection.'
            );
            return;
        }

        if (!range) {
            const anchor = editor.selection.active;
            editor.selections = [new vscode.Selection(anchor, anchor)];
            return;
        }

        const document = editor.document;
        const lineCount = document.lineCount;
        if (lineCount === 0) {
            return;
        }

        const start = clamp(
            Math.min(range.startLine, range.endLine),
            1,
            lineCount
        );
        const end = clamp(
            Math.max(range.startLine, range.endLine),
            1,
            lineCount
        );
        const startPosition = new vscode.Position(start - 1, 0);
        const endLine = document.lineAt(end - 1);
        const endPosition = endLine.range.end;
        editor.selections = [new vscode.Selection(startPosition, endPosition)];
        editor.revealRange(
            new vscode.Range(startPosition, endPosition),
            vscode.TextEditorRevealType.InCenter
        );
    }

    private findEditorForDocument(): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find(
            (candidate) =>
                candidate.document.uri.toString() ===
                this.documentUri.toString()
        );
    }

    private getHtmlForWebview(): string {
        const webview = this.panel.webview;
        const scriptUri = this.getUri(['media', 'visualizer.js']);
        const stylesUri = this.getUri(['media', 'visualizer.css']);
        const controlsIconUri = this.getUri(['media', 'icons', 'controls.svg']);
        const chatIconUri = this.getUri(['media', 'icons', 'bot.svg']);

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${
      webview.cspSource
  } data:; style-src ${webview.cspSource}; script-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${stylesUri}" />
  <title>JSON Atlas Visualizer</title>
</head>
<body>
  <section id="status" role="status" hidden></section>
  <main id="visualizer" role="tree" aria-live="polite">
    <section id="controlDock" class="control-dock" aria-label="Visualizer controls">
      <div class="control-dock__actions">
        <button
          id="chatToggle"
          type="button"
          class="control-dock__chat-button"
          aria-label="Open chat panel"
          title="Open chat panel"
        >
          <img src="${chatIconUri}" width="20" height="20" alt="" aria-hidden="true" />
        </button>
        <button
          id="controlDockToggle"
          class="control-dock__toggle"
          type="button"
          aria-expanded="true"
          title="Hide controls"
        >
          <span class="sr-only">Toggle controls</span>
          <img src="${controlsIconUri}" width="18" height="18" alt="" aria-hidden="true" />
        </button>
      </div>
      <div id="controlDockPanel" class="control-dock__panel">
        <div class="view-switcher" role="toolbar" aria-label="View and search controls">
          <div class="view-switcher__group">
            <label for="visualizerViewSelect">View</label>
            <select id="visualizerViewSelect">
              <option value="graph">Graph</option>
              <option value="tree">Tree</option>
            </select>
          </div>
          <div class="view-switcher__group">
            <label for="visualizerSearchInput">Find</label>
            <input id="visualizerSearchInput" type="search" placeholder="Search keys or values" />
          </div>
        </div>
        <div id="selectionPanel" class="selection-panel" aria-live="polite">
          <form id="selectionLineForm" class="selection-line-form">
            <label for="selectionStartInput">Lines</label>
            <input id="selectionStartInput" type="number" min="1" inputmode="numeric" placeholder="Start" />
            <span class="selection-line-form__dash">–</span>
            <input id="selectionEndInput" type="number" min="1" inputmode="numeric" placeholder="End" />
            <button type="submit">Apply</button>
            <button type="button" id="selectionClearButton">Clear</button>
          </form>
        </div>
      </div>
    </section>
    <section id="chatPanel" class="chat-panel" hidden>
      <header class="chat-panel__header">
        <span>AI Assistant</span>
        <div class="chat-panel__model">
          <img src="${this.getUri([
              'media',
              'icons',
              'brain.svg',
          ])}" width="20" height="20" alt="" aria-hidden="true" />
          <select id="chatModelSelect" disabled aria-label="Select AI model">
            <option>Loading…</option>
          </select>
        </div>
        <div class="chat-panel__actions">
          <button id="chatReset" type="button" title="Clear conversation">Reset</button>
          <button id="chatClose" type="button" title="Close chat">×</button>
        </div>
      </header>
      <div id="chatMessages" class="chat-messages" aria-live="polite"></div>
      <form id="chatForm" class="chat-form">
        <textarea id="chatInput" rows="2" placeholder="Ask about this JSON..."></textarea>
        <div class="chat-form__actions">
          <span id="chatStatus" class="chat-status" aria-live="polite"></span>
          <button type="submit">Send</button>
        </div>
      </form>
    </section>
  </main>
  <script src="${scriptUri}" defer></script>
</body>
</html>`;
    }

    private getUri(pathSegments: string[]): vscode.Uri {
        return this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, ...pathSegments)
        );
    }

    private getPreferredViewMode(): 'graph' | 'tree' {
        const value = vscode.workspace
            .getConfiguration('jsonAtlas')
            .get<string>('defaultVisualizerView', 'graph');
        return value === 'tree' ? 'tree' : 'graph';
    }

    private getGraphScalePreferences(): { auto: boolean; scale: number } {
        const config = vscode.workspace.getConfiguration(
            'jsonAtlas',
            this.documentUri
        );
        const auto = config.get<boolean>('graphAutoScale', true);
        const manual = config.get<number>('graphInitialScale', 1) ?? 1;
        return { auto, scale: clamp(manual, 0.2, 1.2) };
    }

    private getGraphDepthPreference(): number | undefined {
        const config = vscode.workspace.getConfiguration(
            'jsonAtlas',
            this.documentUri
        );
        const requested = config.get<number>('graphMaxExpandedDepth', 5);
        if (
            typeof requested !== 'number' ||
            !Number.isFinite(requested) ||
            requested <= 0
        ) {
            return undefined;
        }
        return Math.max(1, Math.floor(requested));
    }
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function findValueRanges(text: string, exactPath: Segment[]) {
    const matches: { offset: number; length: number }[] = [];

    visit(
        text,
        {
            onLiteralValue: (
                _value,
                offset,
                length,
                _startLine,
                _startCharacter,
                pathSupplier
            ) => {
                const path = pathSupplier();
                if (pathsEqual(path, exactPath)) {
                    matches.push({ offset, length });
                    return false;
                }
                return undefined;
            },
        },
        renameParseOptions
    );

    return matches;
}

function findPropertyKeyRanges(
    text: string,
    propertyName: string,
    exactPath: Segment[],
    arrayAncestor?: Segment[]
) {
    const matches: { offset: number; length: number }[] = [];

    visit(
        text,
        {
            onObjectProperty: (
                property,
                offset,
                length,
                _startLine,
                _startCharacter,
                pathSupplier
            ) => {
                if (property !== propertyName) {
                    return;
                }

                const objectPath = pathSupplier();
                if (arrayAncestor) {
                    if (matchesArrayParentPath(objectPath, arrayAncestor)) {
                        matches.push({ offset, length });
                    }
                    return;
                }

                const fullPath = [...objectPath, property];
                if (pathsEqual(fullPath, exactPath)) {
                    matches.push({ offset, length });
                    return false;
                }
                return undefined;
            },
        },
        renameParseOptions
    );

    return matches;
}

function pathsEqual(a: Segment[], b: Segment[]) {
    if (a.length !== b.length) {
        return false;
    }

    return a.every((segment, index) => segment === b[index]);
}

function matchesArrayParentPath(path: Segment[], ancestor: Segment[]) {
    if (path.length !== ancestor.length + 1) {
        return false;
    }

    if (typeof path[path.length - 1] !== 'number') {
        return false;
    }

    return ancestor.every((segment, index) => path[index] === segment);
}

function formatMessageContent(content: CoreMessage['content']) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === 'string') {
                    return item;
                }
                if (
                    typeof item === 'object' &&
                    item !== null &&
                    'text' in item
                ) {
                    return String(item.text);
                }
                return '';
            })
            .join('');
    }

    return String(content ?? '');
}

function createChatMessage(
    role: 'system' | 'user' | 'assistant',
    content: string
): CoreMessage {
    return { role, content };
}

function extractJsonSnippet(text: string) {
    const match = text.match(/```json\s*([\s\S]*?)```/i);
    if (!match) {
        return undefined;
    }
    return match[1].trim();
}

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
