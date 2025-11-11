import * as vscode from 'vscode';
import { VisualizerPanel } from './visualizerPanel';
import {
  WorkspaceSchemaEntry,
  WorkspaceSchemaReport,
  WorkspaceSchemaScanner,
  WorkspaceScanProgress
} from './workspaceSchemaScanner';

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

interface DashboardViewState {
  status: 'idle' | 'scanning' | 'ready' | 'error';
  message?: string;
  progress?: WorkspaceScanProgress;
  report?: WorkspaceSchemaReport;
  lastUpdated?: string;
}

interface InsightsState {
  title: string;
  documentUri?: string;
  insights: VisualizerSchemaInsight[];
  timestamp?: string;
  dashboard: DashboardViewState;
}

export class SchemaInsightsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'jsonAtlas.schemaInsightsView';
  public static readonly containerCommand = 'workbench.view.extension.jsonAtlas-summary';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private scanTokenSource: vscode.CancellationTokenSource | undefined;

  private state: InsightsState = {
    title: 'Schema Insights',
    insights: [],
    timestamp: undefined,
    dashboard: {
      status: 'idle',
      message: 'Run a workspace scan to inspect schema coverage.'
    }
  };

  constructor(private readonly extensionUri: vscode.Uri, private readonly scanner: WorkspaceSchemaScanner) {}

  public dispose(): void {
    this.scanTokenSource?.cancel();
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // ignore
      }
    }
  }

  public async revealView(): Promise<void> {
    await vscode.commands.executeCommand(SchemaInsightsViewProvider.containerCommand);
    this.view?.show?.(true);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const subscription = webviewView.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      switch (message.type) {
        case 'focusPath':
          this.handleFocusRequest(message.payload);
          return;
        case 'revealEditor':
          void this.handleRevealRequest(message.payload);
          return;
        case 'dashboardScan':
          void this.runWorkspaceScan();
          return;
        case 'dashboardCancel':
          this.cancelWorkspaceScan();
          return;
        case 'dashboardOpenEntry':
          void this.handleOpenEntryRequest(message.payload);
          return;
        case 'dashboardExport':
          void this.exportWorkspaceReport();
          return;
        case 'dashboardOpenFailures':
          void this.showWorkspaceFailurePicker();
          return;
        default:
          break;
      }
    });
    this.disposables.push(subscription);
    this.render();
  }

  public setInsights(document: vscode.TextDocument, insights: VisualizerSchemaInsight[]): void {
    this.state = {
      ...this.state,
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
      ...this.state,
      documentUri: documentUri.toString(),
      insights: [],
      timestamp: new Date().toLocaleTimeString()
    };
    this.render();
  }

  public async runWorkspaceScan(options?: { reveal?: boolean }): Promise<void> {
    if (options?.reveal) {
      await this.revealView();
    }

    if (!this.hasWorkspace()) {
      this.updateDashboardState({
        status: 'error',
        message: 'Open a workspace folder to scan JSON files.'
      });
      void vscode.window.showInformationMessage('Open a workspace folder to scan JSON files.');
      return;
    }

    this.scanTokenSource?.cancel();
    const tokenSource = new vscode.CancellationTokenSource();
    this.scanTokenSource = tokenSource;
    this.updateDashboardState({
      status: 'scanning',
      message: 'Scanning workspace JSON files…',
      progress: undefined
    });

    try {
      const report = await this.scanner.scan({
        token: tokenSource.token,
        onProgress: (progress) => {
          this.updateDashboardState({ progress, status: 'scanning' });
        }
      });
      this.updateDashboardState({
        status: 'ready',
        report,
        progress: undefined,
        message: undefined,
        lastUpdated: new Date().toLocaleTimeString()
      });
    } catch (error) {
      if (tokenSource.token.isCancellationRequested || error instanceof vscode.CancellationError) {
        this.updateDashboardState({
          status: 'idle',
          message: 'Workspace scan cancelled.',
          progress: undefined
        });
        return;
      }
      const description = error instanceof Error ? error.message : String(error);
      this.updateDashboardState({
        status: 'error',
        message: `Workspace scan failed: ${description}`,
        progress: undefined
      });
      void vscode.window.showErrorMessage(`JSON Atlas workspace scan failed: ${description}`);
    } finally {
      if (this.scanTokenSource === tokenSource) {
        this.scanTokenSource.dispose();
        this.scanTokenSource = undefined;
      }
    }
  }

  public async showWorkspaceFailurePicker(options?: { forceRescan?: boolean }): Promise<void> {
    const report = await this.ensureWorkspaceReport(options?.forceRescan);
    if (!report) {
      return;
    }
    const entry = await this.scanner.showFailureQuickPick(report);
    if (!entry) {
      return;
    }
    await this.scanner.openEntry(entry);
  }

  public async exportWorkspaceReport(options?: { forceRescan?: boolean }): Promise<void> {
    const report = await this.ensureWorkspaceReport(options?.forceRescan);
    if (!report) {
      return;
    }

    const defaultUri = this.getDefaultExportUri();
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ['json'] },
      saveLabel: 'Export Schema Report'
    });
    if (!target) {
      return;
    }

    const payload = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(target, payload);
    void vscode.window.showInformationMessage(`Workspace schema report saved to ${target.fsPath}.`);
  }

  private async ensureWorkspaceReport(forceRescan = false): Promise<WorkspaceSchemaReport | undefined> {
    if (!forceRescan && this.state.dashboard.status === 'ready' && this.state.dashboard.report) {
      return this.state.dashboard.report;
    }
    await this.runWorkspaceScan({ reveal: true });
    return this.state.dashboard.report;
  }

  private cancelWorkspaceScan(): void {
    if (!this.scanTokenSource) {
      return;
    }
    this.scanTokenSource.cancel();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.buildHtml(this.state);
  }

  private buildHtml(state: InsightsState): string {
    const nonce = this.generateNonce();
    const insightsMarkup = this.buildInsightsMarkup(state);
    const dashboardMarkup = this.buildDashboardMarkup(state.dashboard);

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
    .layout {
      display: flex;
      flex-direction: row;
      gap: 1rem;
    }
    .layout__main {
      flex: 1.6;
      min-width: 0;
    }
    .layout__sidebar {
      flex: 0.9;
      min-width: 260px;
    }
    @media (max-width: 900px) {
      .layout {
        flex-direction: column;
      }
      .layout__sidebar {
        min-width: 0;
      }
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
    .dashboard {
      border-radius: 0.8rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.02);
      padding: 0.6rem;
    }
    .dashboard summary {
      list-style: none;
      cursor: pointer;
      font-weight: 600;
      margin-bottom: 0.35rem;
    }
    .dashboard summary::-webkit-details-marker {
      display: none;
    }
    .dashboard__content {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 0.35rem;
    }
    .dashboard__toolbar,
    .dashboard__footer {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .dashboard button {
      border-radius: 0.35rem;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-foreground);
      padding: 0.3rem 0.6rem;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .dashboard button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .dashboard button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .dashboard__message,
    .dashboard__progress {
      font-size: 0.8rem;
      opacity: 0.85;
    }
    .dashboard__cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
      gap: 0.4rem;
    }
    .card {
      border-radius: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 0.45rem;
      background: rgba(255, 255, 255, 0.03);
    }
    .card__label {
      font-size: 0.75rem;
      opacity: 0.68;
    }
    .card__value {
      font-size: 1.2rem;
      font-weight: 600;
    }
    .dashboard__list {
      list-style: none;
      margin: 0;
      padding-left: 0;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .dashboard__item {
      display: flex;
      justify-content: space-between;
      gap: 0.4rem;
      font-size: 0.8rem;
      align-items: center;
    }
    .badge {
      border-radius: 999px;
      padding: 0.05rem 0.5rem;
      font-weight: 600;
      font-size: 0.7rem;
      text-transform: uppercase;
    }
    .badge--pass { background: rgba(116, 200, 160, 0.2); color: #7fe0aa; }
    .badge--fail { background: rgba(238, 99, 82, 0.2); color: #ffb4a7; }
    .badge--error { background: rgba(246, 198, 99, 0.2); color: #ffd48a; }
  </style>
</head>
<body>
  <div class="layout">
    <section class="layout__main">
      <div class="header">
        <h1>${this.escapeHtml(state.title)}</h1>
        <span class="timestamp">${state.timestamp ? `Updated ${this.escapeHtml(state.timestamp)}` : ''}</span>
      </div>
      ${insightsMarkup}
    </section>
    <aside class="layout__sidebar">
      ${dashboardMarkup}
    </aside>
  </div>
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
        return;
      }
      if (action === 'reveal') {
        const start = Number(target.getAttribute('data-start'));
        const end = Number(target.getAttribute('data-end'));
        vscode.postMessage({ type: 'revealEditor', payload: { startLine: start, endLine: end } });
        return;
      }
      if (action === 'dashboard-scan') {
        vscode.postMessage({ type: 'dashboardScan' });
        return;
      }
      if (action === 'dashboard-cancel') {
        vscode.postMessage({ type: 'dashboardCancel' });
        return;
      }
      if (action === 'dashboard-open-entry') {
        const entryIndex = Number(target.getAttribute('data-entry'));
        if (!Number.isNaN(entryIndex)) {
          vscode.postMessage({ type: 'dashboardOpenEntry', payload: { entryIndex } });
        }
        return;
      }
      if (action === 'dashboard-export') {
        vscode.postMessage({ type: 'dashboardExport' });
        return;
      }
      if (action === 'dashboard-open-failures') {
        vscode.postMessage({ type: 'dashboardOpenFailures' });
        return;
      }
    });
  </script>
</body>
</html>`;
  }

  private buildInsightsMarkup(state: InsightsState): string {
    if (!state.insights.length) {
      return `<div class="insight-empty">No schema issues detected.</div>`;
    }

    const markup = state.insights
      .map((insight) => {
        const actions = [];
        if (insight.pathKey) {
          actions.push(`<button data-action="focus" data-path="${this.escapeHtml(insight.pathKey)}">Focus</button>`);
        }
        if (typeof insight.startLine === 'number') {
          actions.push(
            `<button data-action="reveal" data-start="${insight.startLine}" data-end="${typeof insight.endLine ===
            'number'
              ? insight.endLine
              : insight.startLine}">Editor</button>`
          );
        }
        const meta = [this.escapeHtml(insight.jsonPath)];
        if (insight.pointer) {
          meta.push(this.escapeHtml(insight.pointer));
        }
        return `<li class="insight insight--${insight.severity}">
          <div class="insight__message">${this.escapeHtml(insight.message)}</div>
          <div class="insight__meta">${meta.join(' • ')}</div>
          ${actions.length ? `<div class="insight__actions">${actions.join('')}</div>` : ''}
        </li>`;
      })
      .join('');

    return `<ul class="insight-list">${markup}</ul>`;
  }

  private buildDashboardMarkup(state: DashboardViewState): string {
    const report = state.report;
    const hasReport = Boolean(report);
    const scanning = state.status === 'scanning';
    const failingEntries = report ? report.entries.filter((entry) => entry.status !== 'pass') : [];
    const openFailuresDisabled = !failingEntries.length || scanning;
    const exportDisabled = !hasReport || scanning;

    const progress = state.progress
      ? `<div class="dashboard__progress">Scanning ${state.progress.processed}/${state.progress.total}${
          state.progress.currentFile ? ` — ${this.escapeHtml(state.progress.currentFile)}` : ''
        }</div>`
      : '';
    const statusMessage = state.message ? `<div class="dashboard__message">${this.escapeHtml(state.message)}</div>` : '';
    const cards = report
      ? `<div class="dashboard__cards">
          ${this.renderCard('Scanned', report.totals.total)}
          ${this.renderCard('Passed', report.totals.passed)}
          ${this.renderCard('Failures', report.totals.failed)}
          ${this.renderCard('Errors', report.totals.errored)}
        </div>`
      : '<div class="dashboard__message">No workspace scan has been run.</div>';
    const lastUpdated = state.lastUpdated ? `<div class="dashboard__message">Updated ${this.escapeHtml(state.lastUpdated)}</div>` : '';

    const list = failingEntries.length
      ? `<ul class="dashboard__list">
          ${failingEntries.slice(0, 4).map((entry, index) => {
            const badge = `<span class="badge badge--${entry.status}">${entry.status.toUpperCase()}</span>`;
            return `<li class="dashboard__item">
              <span>${badge} ${this.escapeHtml(entry.relativePath)}</span>
              <button data-action="dashboard-open-entry" data-entry="${report?.entries.indexOf(entry)}">Open</button>
            </li>`;
          }).join('')}
          ${failingEntries.length > 4 ? `<li class="dashboard__item">+${failingEntries.length - 4} more</li>` : ''}
        </ul>`
      : '<div class="dashboard__message">No failing documents.</div>';

    return `<details class="dashboard" open>
      <summary>Workspace Dashboard</summary>
      <div class="dashboard__content">
        <div class="dashboard__toolbar">
          <button class="primary" data-action="dashboard-scan" ${scanning ? 'disabled aria-disabled="true"' : ''}>${
      scanning ? 'Scanning…' : 'Scan Workspace'
    }</button>
          <button data-action="dashboard-cancel" ${scanning ? '' : 'disabled aria-disabled="true"'}>Cancel</button>
        </div>
        ${progress}
        ${statusMessage}
        ${cards}
        ${lastUpdated}
        ${list}
        <div class="dashboard__footer">
          <button data-action="dashboard-open-failures" ${openFailuresDisabled ? 'disabled aria-disabled="true"' : ''}>Open Failures</button>
          <button data-action="dashboard-export" ${exportDisabled ? 'disabled aria-disabled="true"' : ''}>Export Report</button>
        </div>
      </div>
    </details>`;
  }

  private renderCard(label: string, value: number): string {
    return `<div class="card"><div class="card__label">${this.escapeHtml(label)}</div><div class="card__value">${value}</div></div>`;
  }

  private async handleOpenEntryRequest(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const entryIndex = Number((payload as { entryIndex?: number }).entryIndex);
    if (!Number.isFinite(entryIndex) || entryIndex < 0) {
      return;
    }
    await this.openEntryByIndex(entryIndex);
  }

  private async openEntryByIndex(entryIndex: number): Promise<void> {
    const report = this.state.dashboard.report;
    if (!report) {
      return;
    }
    const entry = report.entries[entryIndex];
    if (!entry) {
      return;
    }
    await this.scanner.openEntry(entry, 0);
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

  private updateDashboardState(update: Partial<DashboardViewState>): void {
    this.state = {
      ...this.state,
      dashboard: {
        ...this.state.dashboard,
        ...update
      }
    };
    this.render();
  }

  private hasWorkspace(): boolean {
    return Boolean(vscode.workspace.workspaceFolders?.length);
  }

  private getDefaultExportUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, 'json-atlas-schema-report.json');
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
