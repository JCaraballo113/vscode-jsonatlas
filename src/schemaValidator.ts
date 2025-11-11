import * as path from 'path';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { findNodeAtLocation, Node, parseTree } from 'jsonc-parser';
const draft07 = require('ajv/dist/refs/json-schema-draft-07.json');
const draft2020 = require('ajv/dist/refs/json-schema-2020-12/schema.json');
const draft2020Applicator = require('ajv/dist/refs/json-schema-2020-12/meta/applicator.json');
const draft2020Content = require('ajv/dist/refs/json-schema-2020-12/meta/content.json');
const draft2020Core = require('ajv/dist/refs/json-schema-2020-12/meta/core.json');
const draft2020Format = require('ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json');
const draft2020MetaData = require('ajv/dist/refs/json-schema-2020-12/meta/meta-data.json');
const draft2020Unevaluated = require('ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json');
const draft2020Validation = require('ajv/dist/refs/json-schema-2020-12/meta/validation.json');

const pointerSegmentRegex = /~[01]/g;

export interface SchemaInfo {
  uri: vscode.Uri;
  schema: unknown;
  schemaText: string;
  root: Node | undefined;
  pointerIndex: Map<string, Node>;
}

export interface SchemaNavigationTarget {
  pointer: string;
  uri: vscode.Uri;
  offset?: number;
  length?: number;
  title?: string;
  description?: string;
}

type JsonPath = (string | number)[];

export interface SchemaResolution {
  schema: unknown;
  pointer: string;
}

export interface SchemaInsight {
  id: string;
  message: string;
  pointer: string;
  path: JsonPath;
  severity: vscode.DiagnosticSeverity;
  keyword: string;
}

export class SchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  private readonly decoder = new TextDecoder('utf-8');
  private readonly validatorCache = new Map<string, { fingerprint: string; validator: ValidateFunction }>();
  private readonly warnedMessages = new Set<string>();
  private readonly schemaInfoByDocument = new Map<string, SchemaInfo>();
  private readonly schemaInsightsByDocument = new Map<string, SchemaInsight[]>();

  constructor() {
    [
      draft07,
      draft2020Applicator,
      draft2020Content,
      draft2020Core,
      draft2020Format,
      draft2020MetaData,
      draft2020Unevaluated,
      draft2020Validation,
      draft2020
    ].forEach((schema) => this.addMetaSchemaSafe(schema));
  }

  public reset() {
    this.validatorCache.clear();
    this.warnedMessages.clear();
    this.schemaInfoByDocument.clear();
    this.schemaInsightsByDocument.clear();
  }

  private addMetaSchemaSafe(meta: unknown) {
    if (!meta || typeof meta !== 'object' || this.ajv.getSchema((meta as { $id?: string }).$id ?? '')) {
      return;
    }
    try {
      this.ajv.addMetaSchema(meta as object);
    } catch {
      // ignore
    }
  }

  public async validate(document: vscode.TextDocument, root: Node | undefined, data: unknown): Promise<vscode.Diagnostic[]> {
    const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);

    this.schemaInfoByDocument.delete(document.uri.toString());
    this.schemaInsightsByDocument.delete(document.uri.toString());

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
      root: schemaRoot,
      pointerIndex: this.buildPointerIndex(schemaRoot)
    });

    const validator = this.getValidator(schemaUri.toString(), schemaContainer);
    if (!validator) {
      return [];
    }

    const valid = validator(data);
    const errors = validator.errors ?? [];
    const insights = this.buildInsightsFromErrors(errors);
    this.schemaInsightsByDocument.set(document.uri.toString(), insights);

    if (valid || !errors.length) {
      return [];
    }

    return errors.map((error) => this.createDiagnostic(error, document, root));
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

  public resolveNavigationTarget(documentUri: vscode.Uri, path: JsonPath): SchemaNavigationTarget | undefined {
    const info = this.schemaInfoByDocument.get(documentUri.toString());
    if (!info) {
      return undefined;
    }

    const resolution = this.resolveSchemaForPath(info, path);
    if (!resolution) {
      return undefined;
    }

    const node = info.pointerIndex.get(resolution.pointer);
    return {
      pointer: resolution.pointer,
      uri: info.uri,
      offset: node?.offset,
      length: node?.length,
      title: this.tryReadString(resolution.schema, 'title'),
      description: this.tryReadString(resolution.schema, 'description')
    };
  }

  public getSchemaInfo(documentUri: vscode.Uri): SchemaInfo | undefined {
    return this.schemaInfoByDocument.get(documentUri.toString());
  }

  public getSchemaInsights(documentUri: vscode.Uri): SchemaInsight[] {
    return this.schemaInsightsByDocument.get(documentUri.toString()) ?? [];
  }

  public resolveSchemaForJsonPath(documentUri: vscode.Uri, path: JsonPath | undefined): SchemaResolution | undefined {
    const info = this.schemaInfoByDocument.get(documentUri.toString());
    if (!info) {
      return undefined;
    }
    return this.resolveSchemaForPath(info, path);
  }

  private buildInsightsFromErrors(errors: ErrorObject[]): SchemaInsight[] {
    if (!errors?.length) {
      return [];
    }

    const insights: SchemaInsight[] = [];
    for (const error of errors) {
      const pointer = error.instancePath ?? '';
      const path = this.pointerToPath(pointer);
      const message = this.formatErrorMessage(error);
      const keyword = error.keyword ?? 'schema';
      const severity =
        keyword === 'required' || keyword === 'deprecated'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error;
      const id = `${pointer ?? ''}::${keyword}::${message}`;
      insights.push({
        id,
        message,
        pointer,
        path,
        severity,
        keyword
      });
    }
    return insights;
  }

  private resolveSchemaForPath(info: SchemaInfo, path: JsonPath | undefined): SchemaResolution | undefined {
    const normalizedPath = Array.isArray(path) ? path : [];
    let state = this.dereferenceSchema(info.schema, '#', info);

    if (!normalizedPath.length) {
      return state;
    }

    for (const segment of normalizedPath) {
      const next =
        typeof segment === 'number'
          ? this.resolveArraySchema(state.schema, state.pointer, segment, info)
          : this.resolvePropertySchema(state.schema, state.pointer, String(segment), info);
      if (!next) {
        return undefined;
      }
      state = this.dereferenceSchema(next.schema, next.pointer, info);
    }

    return state;
  }

  private resolvePropertySchema(schema: unknown, pointer: string, key: string, info: SchemaInfo): SchemaResolution | undefined {
    if (typeof schema === 'boolean') {
      return { schema, pointer };
    }
    if (!this.isRecord(schema)) {
      return undefined;
    }

    const properties = schema.properties;
    if (this.isRecord(properties) && Object.prototype.hasOwnProperty.call(properties, key)) {
      return { schema: properties[key], pointer: this.joinPointer(pointer, 'properties', key) };
    }

    const patternProperties = schema.patternProperties;
    if (this.isRecord(patternProperties)) {
      for (const pattern of Object.keys(patternProperties)) {
        try {
          const regex = new RegExp(pattern);
          if (regex.test(key)) {
            return { schema: patternProperties[pattern], pointer: this.joinPointer(pointer, 'patternProperties', pattern) };
          }
        } catch {
          // ignore invalid regex
        }
      }
    }

    if (this.isSchemaLike(schema.additionalProperties)) {
      return { schema: schema.additionalProperties, pointer: this.joinPointer(pointer, 'additionalProperties') };
    }

    if (this.isSchemaLike(schema.unevaluatedProperties)) {
      return { schema: schema.unevaluatedProperties, pointer: this.joinPointer(pointer, 'unevaluatedProperties') };
    }

    return this.resolveFromCompositeSchemas(schema, pointer, (candidate, candidatePointer) =>
      this.resolvePropertySchema(candidate, candidatePointer, key, info)
    );
  }

  private resolveArraySchema(schema: unknown, pointer: string, index: number, info: SchemaInfo): SchemaResolution | undefined {
    if (typeof schema === 'boolean') {
      return { schema, pointer };
    }
    if (!this.isRecord(schema)) {
      return undefined;
    }

    if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) {
      return { schema: schema.prefixItems[index], pointer: this.joinPointer(pointer, 'prefixItems', index.toString()) };
    }

    if (Array.isArray(schema.items)) {
      if (index < schema.items.length) {
        return { schema: schema.items[index], pointer: this.joinPointer(pointer, 'items', index.toString()) };
      }
    } else if (this.isSchemaLike(schema.items)) {
      return { schema: schema.items, pointer: this.joinPointer(pointer, 'items') };
    }

    if (this.isSchemaLike(schema.contains)) {
      return { schema: schema.contains, pointer: this.joinPointer(pointer, 'contains') };
    }

    if (this.isSchemaLike(schema.additionalItems)) {
      return { schema: schema.additionalItems, pointer: this.joinPointer(pointer, 'additionalItems') };
    }

    if (this.isSchemaLike(schema.unevaluatedItems)) {
      return { schema: schema.unevaluatedItems, pointer: this.joinPointer(pointer, 'unevaluatedItems') };
    }

    return this.resolveFromCompositeSchemas(schema, pointer, (candidate, candidatePointer) =>
      this.resolveArraySchema(candidate, candidatePointer, index, info)
    );
  }

  private resolveFromCompositeSchemas(
    schema: Record<string, unknown>,
    pointer: string,
    resolver: (schema: unknown, pointer: string) => SchemaResolution | undefined
  ): SchemaResolution | undefined {
    const keywords: Array<'allOf' | 'anyOf' | 'oneOf'> = ['allOf', 'anyOf', 'oneOf'];
    for (const keyword of keywords) {
      const block = schema[keyword];
      if (!Array.isArray(block)) {
        continue;
      }
      for (let index = 0; index < block.length; index += 1) {
        const childPointer = this.joinPointer(pointer, keyword, index.toString());
        const result = resolver(block[index], childPointer);
        if (result) {
          return result;
        }
      }
    }

    const thenSchema = schema.then;
    if (this.isSchemaLike(thenSchema)) {
      const match = resolver(thenSchema, this.joinPointer(pointer, 'then'));
      if (match) {
        return match;
      }
    }

    const elseSchema = schema.else;
    if (this.isSchemaLike(elseSchema)) {
      const match = resolver(elseSchema, this.joinPointer(pointer, 'else'));
      if (match) {
        return match;
      }
    }

    return undefined;
  }

  private dereferenceSchema(schema: unknown, pointer: string, info: SchemaInfo): SchemaResolution {
    if (!this.isRecord(schema)) {
      return { schema, pointer };
    }

    let currentSchema: unknown = schema;
    let currentPointer = pointer;
    const visited = new Set<string>();

    while (this.isRecord(currentSchema) && typeof currentSchema.$ref === 'string') {
      const ref = currentSchema.$ref;
      if (!ref.startsWith('#')) {
        break;
      }
      const normalized = ref === '#' ? '#' : ref;
      if (visited.has(normalized)) {
        break;
      }
      visited.add(normalized);
      const target = this.getSchemaAtPointer(info.schema, normalized);
      if (typeof target === 'undefined') {
        break;
      }
      currentSchema = target;
      currentPointer = normalized;
    }

    return { schema: currentSchema, pointer: currentPointer };
  }

  private getSchemaAtPointer(root: unknown, pointer: string): unknown | undefined {
    const segments = this.pointerToSegments(pointer);
    if (!segments.length) {
      return root;
    }
    let current: unknown = root;
    for (const segment of segments) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
          return undefined;
        }
        current = current[index];
        continue;
      }
      if (!this.isRecord(current)) {
        return undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  private buildPointerIndex(root: Node | undefined): Map<string, Node> {
    const index = new Map<string, Node>();
    if (!root) {
      return index;
    }

    const visit = (node: Node, segments: string[]) => {
      index.set(this.buildPointerFromSegments(segments), node);
      if (node.type === 'object') {
        for (const property of node.children ?? []) {
          if (property.type !== 'property' || !property.children || property.children.length < 2) {
            continue;
          }
          const keyNode = property.children[0];
          const valueNode = property.children[1];
          const key = typeof keyNode.value === 'string' ? keyNode.value : String(keyNode.value ?? '');
          visit(valueNode, segments.concat([key]));
        }
        return;
      }
      if (node.type === 'array') {
        (node.children ?? []).forEach((child, index) => {
          visit(child, segments.concat([index.toString()]));
        });
      }
    };

    visit(root, []);
    return index;
  }

  private pointerToSegments(pointer: string): string[] {
    if (!pointer || pointer === '#') {
      return [];
    }
    const trimmed = pointer.startsWith('#/') ? pointer.slice(2) : pointer.replace(/^#/, '');
    if (!trimmed) {
      return [];
    }
    return trimmed.split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  }

  private buildPointerFromSegments(segments: string[]): string {
    if (!segments.length) {
      return '#';
    }
    return `#/${segments.map((segment) => this.escapePointerSegment(segment)).join('/')}`;
  }

  private joinPointer(pointer: string, ...segments: (string | number)[]): string {
    const base = this.pointerToSegments(pointer);
    for (const segment of segments) {
      base.push(String(segment));
    }
    return this.buildPointerFromSegments(base);
  }

  private escapePointerSegment(value: string): string {
    return value.replace(/~/g, '~0').replace(/\//g, '~1');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isSchemaLike(value: unknown): value is unknown {
    return typeof value === 'boolean' || this.isRecord(value);
  }

  private tryReadString(schema: unknown, key: string): string | undefined {
    if (!this.isRecord(schema)) {
      return undefined;
    }
    const value = schema[key];
    return typeof value === 'string' ? value : undefined;
  }
}
