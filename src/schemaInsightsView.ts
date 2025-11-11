import * as vscode from 'vscode';
import { VisualizerPanel } from './visualizerPanel';

export interface VisualizerSchemaInsight {
  id: string;
  message: string;
  severity: 'error' | 'warning';
  jsonPath: string;
  pointer?: string;
  pathKey?: string;
  startLine?: number;
  endLine?: number;
}

interface InsightsState {
  title: string;
  documentUri?: string;
  insights: VisualizerSchemaInsight[];
  timestamp?: string;
}

export class SchemaInsightsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'jsonAtlas.schemaInsightsView';

  private view: vscode.WebviewView | undefined;
  private state: InsightsState = {
    title: 'Schema Insights',
    insights: [],
    timestamp: undefined
  };

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

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
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'focusPath') {
        this.handleFocusRequest(message.payload);
        return;
      }

      if (message.type === 'revealEditor') {
        void this.handleRevealRequest(message.payload);
        return;
      }
    });
    this.render();
  }

  public setInsights(document: vscode.TextDocument, insights: VisualizerSchemaInsight[]): void {
    this.state = {
      title: document.uri.fsPath.split(/[\\/]/).pop() ?? document.uri.path,
      documentUri: document.uri.toString(),
      insights,
      timestamp: new Date().toLocaleTimeString()
    };
    this.render();
  }

  public clearInsights(documentUri: vscode.Uri): void {
    if (this.state.documentUri !== documentUri.toString()) {
      return;
    }
    this.state = {
      title: this.state.title,
      documentUri: documentUri.toString(),
      insights: [],
      timestamp: new Date().toLocaleTimeString()
    };
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.buildHtml(this.state);
  }

  private buildHtml(state: InsightsState): string {
    const nonce = this.generateNonce();
    const insightsMarkup = state.insights
      .map((insight) => {
        const actions = [];
        if (insight.pathKey) {
          actions.push(
            `<button data-action="focus" data-path="${this.escapeHtml(insight.pathKey)}">Focus</button>`
          );
        }
        if (typeof insight.startLine === 'number') {
          actions.push(
            `<button data-action="reveal" data-start="${insight.startLine}" data-end="${typeof insight.endLine === 'number' ? insight.endLine : insight.startLine}">Editor</button>`
          );
        }
        const meta = [this.escapeHtml(insight.jsonPath)];
        if (insight.pointer) {
          meta.push(this.escapeHtml(insight.pointer));
        }
        return `<li class="insight insight--${insight.severity}">
  <div class="insight__message">${this.escapeHtml(insight.message)}</div>
  <div class="insight__meta">${meta.join(' • ')}</div>
  ${
    actions.length
      ? `<div class="insight__actions">${actions.join('')}</div>`
      : ''
  }
</li>`;
      })
      .join('');

  const body = state.insights.length
    ? `<ul class="insight-list">${insightsMarkup}</ul>`
    : `<div class="insight-empty">No schema issues detected.</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view?.webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 1rem;
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .header h1 {
      font-size: 1rem;
      margin: 0;
    }
    .timestamp {
      font-size: 0.75rem;
      opacity: 0.7;
    }
    .insight-empty {
      font-size: 0.9rem;
      opacity: 0.75;
    }
    .insight-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .insight {
      border-radius: 0.65rem;
      padding: 0.55rem 0.7rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.02);
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .insight--warning {
      border-color: rgba(245, 169, 127, 0.4);
      background: rgba(245, 169, 127, 0.08);
    }
    .insight--error {
      border-color: rgba(238, 99, 82, 0.5);
      background: rgba(238, 99, 82, 0.1);
    }
    .insight__message {
      font-weight: 600;
    }
    .insight__meta {
      font-size: 0.8rem;
      opacity: 0.8;
    }
    .insight__actions {
      display: inline-flex;
      gap: 0.4rem;
    }
    .insight__actions button {
      border-radius: 0.45rem;
      border: 1px solid rgba(255, 255, 255, 0.3);
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 0.15rem 0.6rem;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${this.escapeHtml(state.title)}</h1>
    <span class="timestamp">${state.timestamp ? `Updated ${this.escapeHtml(state.timestamp)}` : ''}</span>
  </div>
  <div id="insightsRoot">${body}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.body.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const action = target.getAttribute('data-action');
      if (action === 'focus') {
        const path = target.getAttribute('data-path');
        if (path) {
          vscode.postMessage({ type: 'focusPath', payload: { path } });
        }
      }
      if (action === 'reveal') {
        const start = Number(target.getAttribute('data-start'));
        const end = Number(target.getAttribute('data-end'));
        vscode.postMessage({ type: 'revealEditor', payload: { startLine: start, endLine: end } });
      }
    });
  </script>
</body>
</html>`;
  }

  private handleFocusRequest(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const path = (payload as { path?: string }).path;
    if (!path || typeof path !== 'string' || !this.state.documentUri) {
      return;
    }

    const uri = vscode.Uri.parse(this.state.documentUri);
    if (!VisualizerPanel.isDocumentActive(uri)) {
      void vscode.commands.executeCommand('jsonAtlas.openVisualizerPanel').then(() => {
        VisualizerPanel.focusPath(uri, path);
      });
      return;
    }

    VisualizerPanel.focusPath(uri, path);
  }

  private async handleRevealRequest(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object' || !this.state.documentUri) {
      return;
    }
    const startLine = Number((payload as { startLine?: number }).startLine);
    const endLine = Number((payload as { endLine?: number }).endLine);
    if (!Number.isFinite(startLine)) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.state.documentUri));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const start = document.lineAt(Math.max(0, startLine)).range.start;
      const end = document.lineAt(Number.isFinite(endLine) ? Math.max(0, endLine) : Math.max(0, startLine)).range.end;
      const range = new vscode.Range(start, end);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Unable to reveal insight: ${message}`);
    }
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (match) => {
      switch (match) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return match;
      }
    });
  }

  private generateNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 16; i += 1) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
