import * as path from 'path';
import * as vscode from 'vscode';

interface AssignmentCacheEntry {
  data: Record<string, string>;
}

const ASSIGNMENT_FILE = 'jsonAtlas.schemaAssignments.json';

export class SchemaAssociationStore {
  private readonly cache = new Map<string, AssignmentCacheEntry>();

  public async getSchemaReference(documentUri: vscode.Uri): Promise<string | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) {
      return undefined;
    }
    const assignments = await this.readAssignments(workspaceFolder);
    const key = this.buildKey(workspaceFolder, documentUri);
    return assignments[key];
  }

  public async setSchemaReference(documentUri: vscode.Uri, reference: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) {
      throw new Error('Schema associations can only be stored for workspace files.');
    }
    const assignments = await this.readAssignments(workspaceFolder);
    assignments[this.buildKey(workspaceFolder, documentUri)] = reference;
    await this.writeAssignments(workspaceFolder, assignments);
  }

  public async clearSchemaReference(documentUri: vscode.Uri): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) {
      return;
    }
    const assignments = await this.readAssignments(workspaceFolder);
    const key = this.buildKey(workspaceFolder, documentUri);
    if (assignments[key]) {
      delete assignments[key];
      await this.writeAssignments(workspaceFolder, assignments);
    }
  }

  public async listAssignments(workspaceFolder: vscode.WorkspaceFolder): Promise<Record<string, string>> {
    return this.readAssignments(workspaceFolder);
  }

  private buildKey(folder: vscode.WorkspaceFolder, documentUri: vscode.Uri): string {
    if (documentUri.scheme !== 'file') {
      return documentUri.toString();
    }
    const relative = path.relative(folder.uri.fsPath, documentUri.fsPath);
    return relative.split(path.sep).join('/');
  }

  private async readAssignments(folder: vscode.WorkspaceFolder): Promise<Record<string, string>> {
    const key = folder.uri.toString();
    const cached = this.cache.get(key);
    if (cached) {
      return cached.data;
    }

    const fileUri = this.getAssignmentsFile(folder);
    try {
      const buffer = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(buffer).toString('utf8');
      const parsed = JSON.parse(text);
      const data = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
      this.cache.set(key, { data });
      return data;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        const data: Record<string, string> = {};
        this.cache.set(key, { data });
        return data;
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Failed to read schema assignments: ${message}`);
      const data: Record<string, string> = {};
      this.cache.set(key, { data });
      return data;
    }
  }

  private async writeAssignments(folder: vscode.WorkspaceFolder, assignments: Record<string, string>): Promise<void> {
    const fileUri = this.getAssignmentsFile(folder);
    const dir = vscode.Uri.joinPath(folder.uri, '.vscode');
    await vscode.workspace.fs.createDirectory(dir);
    const text = JSON.stringify(assignments, null, 2);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(text, 'utf8'));
    this.cache.set(folder.uri.toString(), { data: assignments });
  }

  private getAssignmentsFile(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, '.vscode', ASSIGNMENT_FILE);
  }
}
