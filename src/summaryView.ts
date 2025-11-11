import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { AiService } from './aiService';

type SummaryStatus = 'idle' | 'generating' | 'ready' | 'error';

type SummaryState = {
  title: string;
  body: string;
  timestamp?: string;
  status: SummaryStatus;
};

export class SummaryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'jsonAtlas.summaryView';
  public static readonly containerCommand = 'workbench.view.extension.jsonAtlas-summary';
  public static readonly containerId = 'jsonAtlas-summary';

  private view: vscode.WebviewView | undefined;
  private readonly markdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false
  });
  private state: SummaryState = {
    title: 'JSON Summary',
    body: 'Run "JSON Atlas: Summarize JSON" to generate a summary.',
    status: 'idle'
  };

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly ai: AiService) {
    this.disposables.push(this.ai.onModelChanged(() => this.render()));
  }

  public dispose(): void {
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // ignore
      }
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'summarize') {
        void vscode.commands.executeCommand('jsonAtlas.summarizeJson');
        return;
      }

      if (message?.type === 'setModel') {
        void this.applyModelSelection(message.payload);
      }
    });
    this.render();
  }

  public async showGenerating(documentName: string): Promise<void> {
    await this.revealPanel();
    this.state = {
      title: documentName,
      body: 'Generating summary…',
      status: 'generating'
    };
    this.render();
  }

  public async showSummary(documentName: string, summary: string): Promise<void> {
    await this.revealPanel();
    this.state = {
      title: documentName,
      body: summary,
      timestamp: new Date().toLocaleTimeString(),
      status: 'ready'
    };
    this.render();
  }

  public showError(documentName: string, message: string): void {
    this.state = {
      title: documentName,
      body: message,
      status: 'error'
    };
    this.render();
  }

  private async applyModelSelection(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const { modelId } = payload as { modelId?: string };
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return;
    }

    await this.ai.setSelectedModel(modelId);
    this.render();
  }

  private async revealPanel() {
    await vscode.commands.executeCommand(SummaryViewProvider.containerCommand);
    await this.moveViewToRightmost();
    if (this.view) {
      this.view.show?.(true);
    }
  }

  private async moveViewToRightmost() {
    try {
      await vscode.commands.executeCommand('vscode.moveViews', {
        viewIds: [SummaryViewProvider.viewId],
        destinationId: SummaryViewProvider.containerId,
        position: Number.MAX_SAFE_INTEGER
      });
    } catch {
      // Best-effort; ignore if command is unavailable.
    }
  }

  private render() {
    if (!this.view) {
      return;
    }

    this.view.description =
      this.state.status === 'ready' && this.state.timestamp ? `Updated ${this.state.timestamp}` : undefined;
    this.view.webview.html = this.buildHtml(this.state);
  }

  private buildHtml(state: SummaryState) {
    const nonce = this.generateNonce();
    const escapedTitle = this.escapeHtml(state.title);
    const escapedTimestamp = state.timestamp ? this.escapeHtml(state.timestamp) : '';
    const isGenerating = state.status === 'generating';
    const buttonDisabled = isGenerating ? 'disabled aria-disabled="true"' : '';
    const bodyHtml =
      state.status === 'ready'
        ? `<div class="summary-body">${this.markdown.render(state.body)}</div>`
        : `<div class="placeholder placeholder--${state.status}">${this.escapeHtml(state.body)}</div>`;
    const modelOptions = this.ai.getModelOptions();
    const selectedModelId = this.ai.getSelectedModelId();
    const modelOptionsMarkup = modelOptions
      .map((option) => {
        const selected = option.id === selectedModelId ? 'selected' : '';
        const label = this.escapeHtml(option.label);
        return `<option value="${this.escapeHtml(option.id)}" ${selected}>${label}</option>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view?.webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 1rem;
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    .summary-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    .summary-header h1 {
      font-size: 1rem;
      margin: 0;
      flex: 1;
    }
    .timestamp {
      font-size: 0.8rem;
      opacity: 0.7;
      margin-bottom: 0.75rem;
    }
    .placeholder {
      margin: 0;
      padding: 0.75rem 0;
      font-size: 0.95rem;
      opacity: 0.85;
    }
    .placeholder--generating {
      font-style: italic;
      animation: pulse 1.5s infinite ease-in-out;
    }
    .placeholder--error {
      color: var(--vscode-editorError-foreground, #f38ba8);
    }
    pre {
      margin: 0;
      font-size: 0.85rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--vscode-editorHoverWidget-background, rgba(0,0,0,0.1));
      border-radius: 0.75rem;
      padding: 0.9rem 1rem;
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(0,0,0,0.15));
    }
    .summary-body {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      font-size: 0.9rem;
      line-height: 1.55;
    }
    .summary-body h1,
    .summary-body h2,
    .summary-body h3 {
      font-size: 0.95rem;
      margin: 0.65rem 0 0.35rem;
    }
    .summary-body ul {
      margin: 0.15rem 0 0.75rem 1.2rem;
      padding: 0;
    }
    .summary-body li {
      margin: 0.15rem 0;
    }
    .summary-body strong {
      color: var(--vscode-editor-foreground);
      font-weight: 600;
    }
    .summary-body code {
      font-family: SFMono-Regular, Consolas, monospace;
      font-size: 0.85em;
      background: var(--vscode-editorHoverWidget-background, rgba(255,255,255,0.05));
      border-radius: 0.3rem;
      padding: 0.05rem 0.4rem;
    }
    .summary-body a {
      color: var(--vscode-textLink-foreground, #7dcfff);
      text-decoration: none;
    }
    .summary-body a:hover {
      text-decoration: underline;
    }
    .summary-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .summary-model {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .summary-model img {
      display: block;
      width: 20px;
      height: 20px;
    }
    .summary-model select {
      border-radius: 0.5rem;
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.35));
      background: var(--vscode-input-background, rgba(0,0,0,0.35));
      color: inherit;
      padding: 0.15rem 0.5rem;
      font: inherit;
    }
    .summary-actions button {
      border-radius: 999px;
      border: 1px solid var(--vscode-button-border, rgba(255,255,255,0.2));
      background: var(--vscode-button-background, rgba(125,196,228,0.25));
      color: var(--vscode-button-foreground, var(--vscode-editor-foreground));
      font: inherit;
      padding: 0.25rem 0.9rem;
      cursor: pointer;
    }
    .summary-actions button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="summary-header">
    <h1>${escapedTitle}</h1>
    <div class="summary-actions">
      <div class="summary-model">
        <img src="${this.getAssetUri('media/icons/brain.png')}" alt="" aria-hidden="true" />
        <select id="summaryModelSelect" aria-label="Select AI model">
          ${modelOptionsMarkup}
        </select>
      </div>
      <button id="summaryRefresh" type="button" ${buttonDisabled}>Generate Summary</button>
    </div>
  </div>
  ${state.status === 'ready' && escapedTimestamp ? `<div class="timestamp">${escapedTimestamp}</div>` : ''}
  ${bodyHtml}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const button = document.getElementById('summaryRefresh');
    if (button) {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'summarize' });
      });
    }
    const modelSelect = document.getElementById('summaryModelSelect');
    if (modelSelect) {
      modelSelect.addEventListener('change', (event) => {
        const value = event.target.value;
        if (value) {
          vscode.postMessage({ type: 'setModel', payload: { modelId: value } });
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private getAssetUri(...segments: string[]): string {
    if (!this.view) {
      return '';
    }
    return this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...segments)).toString();
  }

  private generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 16; i += 1) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
