import * as path from 'path';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { findNodeAtLocation, Node, parseTree } from 'jsonc-parser';

const pointerSegmentRegex = /~[01]/g;

export interface SchemaInfo {
  uri: vscode.Uri;
  schema: unknown;
  schemaText: string;
  root: Node | undefined;
}

export class SchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  private readonly decoder = new TextDecoder('utf-8');
  private readonly validatorCache = new Map<string, { fingerprint: string; validator: ValidateFunction }>();
  private readonly warnedMessages = new Set<string>();
  private readonly schemaInfoByDocument = new Map<string, SchemaInfo>();

  public reset() {
    this.validatorCache.clear();
    this.warnedMessages.clear();
  }

  public async validate(document: vscode.TextDocument, root: Node | undefined, data: unknown): Promise<vscode.Diagnostic[]> {
    const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);

    this.schemaInfoByDocument.delete(document.uri.toString());

    if (!config.get<boolean>('enableSchemaValidation')) {
      return [];
    }

    const schemaPath = config.get<string>('schemaPath')?.trim();
    if (!schemaPath) {
      return [];
    }

    const schemaUri = this.resolveSchemaUri(document, schemaPath);
    if (!schemaUri) {
      this.warnOnce(`Unable to resolve schema path: ${schemaPath}`);
      return [];
    }

    const schemaContainer = await this.loadSchema(schemaUri);
    if (!schemaContainer) {
      return [];
    }

    const schemaRoot = parseTree(schemaContainer.text);
    this.schemaInfoByDocument.set(document.uri.toString(), {
      uri: schemaUri,
      schema: schemaContainer.schema,
      schemaText: schemaContainer.text,
      root: schemaRoot
    });

    const validator = this.getValidator(schemaUri.toString(), schemaContainer);
    if (!validator) {
      return [];
    }

    const valid = validator(data);
    if (valid || !validator.errors?.length) {
      return [];
    }

    return validator.errors.map((error) => this.createDiagnostic(error, document, root));
  }

  private resolveSchemaUri(document: vscode.TextDocument, schemaPath: string): vscode.Uri | undefined {
    if (path.isAbsolute(schemaPath)) {
      return vscode.Uri.file(schemaPath);
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const segments = schemaPath.split(/[\\/]+/).filter(Boolean);
    return vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
  }

  private async loadSchema(uri: vscode.Uri): Promise<{ schema: unknown; fingerprint: string; text: string } | undefined> {
    try {
      const buffer = await vscode.workspace.fs.readFile(uri);
      const text = this.decoder.decode(buffer);
      const schema = JSON.parse(text);
      return { schema, fingerprint: text, text };
    } catch (error) {
      this.warnOnce(`Failed to load schema from ${uri.fsPath}: ${this.describeError(error)}`);
      return undefined;
    }
  }

  private getValidator(key: string, payload: { schema: unknown; fingerprint: string }): ValidateFunction | undefined {
    const cached = this.validatorCache.get(key);
    if (cached && cached.fingerprint === payload.fingerprint) {
      return cached.validator;
    }

    try {
      const validator = this.ajv.compile(payload.schema as object);
      this.validatorCache.set(key, { fingerprint: payload.fingerprint, validator });
      return validator;
    } catch (error) {
      this.validatorCache.delete(key);
      this.warnOnce(`Invalid schema at ${key}: ${this.describeError(error)}`);
      return undefined;
    }
  }

  private createDiagnostic(error: ErrorObject, document: vscode.TextDocument, root: Node | undefined): vscode.Diagnostic {
    const range = this.getRange(error.instancePath, document, root);
    const message = this.formatErrorMessage(error);
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = 'JSON Schema';
    return diagnostic;
  }

  private getRange(pointer: string, document: vscode.TextDocument, root: Node | undefined): vscode.Range {
    if (!root) {
      const end = document.positionAt(document.getText().length);
      return new vscode.Range(new vscode.Position(0, 0), end);
    }

    const pathSegments = this.pointerToPath(pointer);
    const target = findNodeAtLocation(root, pathSegments) ?? root;
    return new vscode.Range(
      document.positionAt(target.offset),
      document.positionAt(target.offset + target.length)
    );
  }

  private pointerToPath(pointer: string): (string | number)[] {
    if (!pointer) {
      return [];
    }

    return pointer
      .split('/')
      .slice(1)
      .map((segment) => segment.replace(pointerSegmentRegex, (match) => (match === '~1' ? '/' : '~')))
      .map((segment) => {
        const numeric = Number(segment);
        return Number.isInteger(numeric) && String(numeric) === segment ? numeric : segment;
      });
  }

  private formatErrorMessage(error: ErrorObject): string {
    if (error.keyword === 'required' && typeof error.params?.missingProperty === 'string') {
      return `Missing required property: ${error.params.missingProperty}`;
    }

    if (error.keyword === 'enum') {
      return `Value must be one of: ${this.stringifyArray(error.params?.allowedValues)}`;
    }

    return error.message ?? 'Schema validation error';
  }

  private stringifyArray(values: unknown): string {
    return Array.isArray(values) ? values.map((value) => JSON.stringify(value)).join(', ') : '';
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private warnOnce(message: string) {
    if (this.warnedMessages.has(message)) {
      return;
    }

    this.warnedMessages.add(message);
    void vscode.window.showWarningMessage(message);
  }

  public getSchemaInfo(documentUri: vscode.Uri): SchemaInfo | undefined {
    return this.schemaInfoByDocument.get(documentUri.toString());
  }
}
