import * as vscode from 'vscode';
import { printParseErrorCode } from 'jsonc-parser';
import { SchemaInfo, SchemaValidator } from './schemaValidator';
import { analyzeJsonText } from './jsonAnalysis';

export type WorkspaceFileStatus = 'pass' | 'fail' | 'error';

export interface WorkspaceScanProgress {
  processed: number;
  total: number;
  currentFile?: string;
}

export interface WorkspaceSchemaIssue {
  message: string;
  severity: 'error' | 'warning';
  location?: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export interface WorkspaceSchemaEntry {
  uri: string;
  relativePath: string;
  schemaLabel: string;
  schemaUri?: string;
  status: WorkspaceFileStatus;
  issueCount: number;
  issues: WorkspaceSchemaIssue[];
}

export interface WorkspaceSchemaReport {
  generatedAt: string;
  totals: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
  };
  entries: WorkspaceSchemaEntry[];
}

export class WorkspaceSchemaScanner {
  private static readonly includeGlob = '**/*.{json,jsonc}';
  private static readonly excludeGlob =
    '{**/node_modules/**,**/bower_components/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**}';

  constructor(private readonly validator: SchemaValidator) {}

  public async scan(options?: {
    token?: vscode.CancellationToken;
    onProgress?: (progress: WorkspaceScanProgress) => void;
  }): Promise<WorkspaceSchemaReport> {
    const files = await vscode.workspace.findFiles(
      WorkspaceSchemaScanner.includeGlob,
      WorkspaceSchemaScanner.excludeGlob
    );
    const sorted = files.sort((a, b) => this.toRelativePath(a).localeCompare(this.toRelativePath(b)));

    const entries: WorkspaceSchemaEntry[] = [];
    let passed = 0;
    let failed = 0;
    let errored = 0;
    const total = sorted.length;

    if (!total) {
      return {
        generatedAt: new Date().toISOString(),
        totals: { total: 0, passed: 0, failed: 0, errored: 0 },
        entries: []
      };
    }

    for (let index = 0; index < sorted.length; index += 1) {
      if (options?.token?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      const uri = sorted[index];
      const entry = await this.evaluateDocument(uri);
      entries.push(entry);

      if (entry.status === 'pass') {
        passed += 1;
      } else if (entry.status === 'fail') {
        failed += 1;
      } else {
        errored += 1;
      }

      options?.onProgress?.({
        processed: index + 1,
        total,
        currentFile: entry.relativePath
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      totals: { total, passed, failed, errored },
      entries
    };
  }

  public async showFailureQuickPick(report: WorkspaceSchemaReport): Promise<WorkspaceSchemaEntry | undefined> {
    const failingEntries = report.entries
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry.status !== 'pass');

    if (!failingEntries.length) {
      void vscode.window.showInformationMessage('All workspace JSON documents pass schema validation.');
      return undefined;
    }

    const picks = failingEntries.map((item) => {
      const detail =
        item.entry.status === 'fail'
          ? `${item.entry.issueCount} schema issue${item.entry.issueCount === 1 ? '' : 's'}`
          : 'JSON parse error';
      return {
        label: item.entry.relativePath,
        description: item.entry.schemaLabel,
        detail,
        index: item.index
      };
    });

    const selection = await vscode.window.showQuickPick(
      picks.map((pick) => ({
        label: pick.label,
        description: pick.description,
        detail: pick.detail,
        index: pick.index
      })),
      { placeHolder: 'Select a failing JSON document to open' }
    );

    return selection ? report.entries[selection.index] : undefined;
  }

  public async openEntry(entry: WorkspaceSchemaEntry, issueIndex = 0): Promise<void> {
    const uri = vscode.Uri.parse(entry.uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const issue = entry.issues[issueIndex];
    if (issue?.location) {
      const range = new vscode.Range(
        issue.location.startLine,
        issue.location.startCharacter,
        issue.location.endLine,
        issue.location.endCharacter
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }

  private async evaluateDocument(uri: vscode.Uri): Promise<WorkspaceSchemaEntry> {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        uri: uri.toString(),
        relativePath: this.toRelativePath(uri),
        schemaLabel: 'Unknown',
        status: 'error',
        issueCount: 1,
        issues: [
          {
            message: `Failed to open file: ${message}`,
            severity: 'error'
          }
        ]
      };
    }

    const analysis = analyzeJsonText(document.getText());
    if (analysis.errors.length) {
      const issues = analysis.errors.map((parseError) => this.createParseIssue(document, parseError));
      return {
        uri: uri.toString(),
        relativePath: this.toRelativePath(uri),
        schemaLabel: 'Unassigned',
        status: 'error',
        issueCount: issues.length,
        issues
      };
    }

    const diagnostics = await this.validator.validate(document, analysis.root, analysis.data);
    const schemaInfo = this.validator.getSchemaInfo(document.uri);
    const schemaDescriptor = this.describeSchema(schemaInfo);

    if (!diagnostics.length) {
      return {
        uri: uri.toString(),
        relativePath: this.toRelativePath(uri),
        schemaLabel: schemaDescriptor.label,
        schemaUri: schemaDescriptor.uri,
        status: 'pass',
        issueCount: 0,
        issues: []
      };
    }

    const issues = diagnostics.map((diagnostic) => this.convertDiagnostic(diagnostic));
    return {
      uri: uri.toString(),
      relativePath: this.toRelativePath(uri),
      schemaLabel: schemaDescriptor.label,
      schemaUri: schemaDescriptor.uri,
      status: 'fail',
      issueCount: issues.length,
      issues
    };
  }

  private createParseIssue(
    document: vscode.TextDocument,
    parseError: { offset: number; length: number; error: number }
  ): WorkspaceSchemaIssue {
    const start = document.positionAt(parseError.offset);
    const end = document.positionAt(parseError.offset + parseError.length);
    return {
      message: `JSON parse error: ${printParseErrorCode(parseError.error)}`,
      severity: 'error',
      location: {
        startLine: start.line,
        startCharacter: start.character,
        endLine: end.line,
        endCharacter: end.character
      }
    };
  }

  private convertDiagnostic(diagnostic: vscode.Diagnostic): WorkspaceSchemaIssue {
    return {
      message: diagnostic.message,
      severity: diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error',
      location: {
        startLine: diagnostic.range.start.line,
        startCharacter: diagnostic.range.start.character,
        endLine: diagnostic.range.end.line,
        endCharacter: diagnostic.range.end.character
      }
    };
  }

  private describeSchema(info: SchemaInfo | undefined): { label: string; uri?: string } {
    if (!info) {
      return { label: 'Unassigned' };
    }
    const uri = info.uri;
    if (uri.scheme === 'file') {
      const relative = this.toRelativePath(uri);
      return { label: relative || uri.fsPath, uri: uri.toString() };
    }
    return { label: uri.toString(), uri: uri.toString() };
  }

  private toRelativePath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false) || uri.fsPath || uri.toString();
  }
}
