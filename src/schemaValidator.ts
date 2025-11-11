import * as path from 'path';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { findNodeAtLocation, Node, parseTree } from 'jsonc-parser';
import { minimatch } from 'minimatch';
import { SchemaAssociationStore } from './schemaAssociations';
import * as http from 'http';
import * as https from 'https';
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

type SchemaSource =
  | { kind: 'uri'; uri: vscode.Uri; cacheKey: string }
  | { kind: 'inline'; cacheKey: string; schema: unknown; text: string; virtualUri: vscode.Uri };

interface JsonSchemaMapping {
  fileMatch?: string[] | string;
  url?: string;
  schema?: unknown;
}

export class SchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  private readonly decoder = new TextDecoder('utf-8');
  private readonly validatorCache = new Map<string, { fingerprint: string; validator: ValidateFunction }>();
  private readonly warnedMessages = new Set<string>();
  private readonly schemaInfoByDocument = new Map<string, SchemaInfo>();
  private readonly schemaInsightsByDocument = new Map<string, SchemaInsight[]>();
  private associationStore: SchemaAssociationStore | undefined;

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

  public setAssociationStore(store: SchemaAssociationStore) {
    this.associationStore = store;
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

    const schemaSource = await this.resolveSchemaSource(document, root);
    if (!schemaSource) {
      return [];
    }

    const schemaContainer = await this.loadSchema(schemaSource);
    if (!schemaContainer) {
      return [];
    }

    const schemaUri = schemaSource.kind === 'uri' ? schemaSource.uri : schemaSource.virtualUri;
    const schemaRoot = parseTree(schemaContainer.text);
    this.schemaInfoByDocument.set(document.uri.toString(), {
      uri: schemaUri,
      schema: schemaContainer.schema,
      schemaText: schemaContainer.text,
      root: schemaRoot,
      pointerIndex: this.buildPointerIndex(schemaRoot)
    });

    const validator = this.getValidator(schemaSource.cacheKey, schemaContainer);
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

  private getEmbeddedSchemaReference(root: Node | undefined): string | undefined {
    if (!root || root.type !== 'object') {
      return undefined;
    }
    for (const property of root.children ?? []) {
      if (!property || property.type !== 'property' || !property.children || property.children.length < 2) {
        continue;
      }
      const keyNode = property.children[0];
      const valueNode = property.children[1];
      if (keyNode?.value === '$schema' && typeof valueNode?.value === 'string') {
        return valueNode.value;
      }
    }
    return undefined;
  }

  private resolveFromJsonSchemasConfig(document: vscode.TextDocument): SchemaSource | undefined {
    const config = vscode.workspace.getConfiguration('json', document.uri);
    const mappings = config.get<JsonSchemaMapping[]>('schemas', []);
    if (!Array.isArray(mappings) || !mappings.length) {
      return undefined;
    }

    for (const mapping of mappings) {
      if (!mapping) {
        continue;
      }
      const fileMatches = this.normalizeFileMatches(mapping.fileMatch);
      if (fileMatches.length && !this.matchesAnyPattern(document, fileMatches)) {
        continue;
      }

      if (typeof mapping.schema !== 'undefined') {
        const text = JSON.stringify(mapping.schema, null, 2);
        const baseId = mapping.url?.trim() || `json-schema:${fileMatches.join('|') || document.uri.toString()}`;
        const cacheKey = `inline:${baseId}`;
        const virtual = this.tryParseUri(baseId) ?? vscode.Uri.parse(baseId.startsWith('json-schema:') ? baseId : `json-schema:${encodeURIComponent(baseId)}`);
        return {
          kind: 'inline',
          cacheKey,
          schema: mapping.schema,
          text,
          virtualUri: virtual
        };
      }

      if (typeof mapping.url === 'string' && mapping.url.trim()) {
        const uri = this.resolveReferenceUri(document, mapping.url.trim());
        if (uri) {
          return { kind: 'uri', uri, cacheKey: uri.toString() };
        }
      }
    }
    return undefined;
  }

  private resolveFromAtlasConfig(document: vscode.TextDocument): SchemaSource | undefined {
    const config = vscode.workspace.getConfiguration('jsonAtlas', document.uri);
    const mappings = config.get<Array<{ pattern?: string; schema?: string }>>('schemas', []);
    if (!Array.isArray(mappings) || !mappings.length) {
      return undefined;
    }

    const relativePath = this.getDocumentRelativePath(document);
    for (const mapping of mappings) {
      if (!mapping || typeof mapping.pattern !== 'string' || typeof mapping.schema !== 'string') {
        continue;
      }
      const matchesRelative = relativePath ? minimatch(relativePath, mapping.pattern, { dot: true }) : false;
      const matchesAbsolute = document.uri.scheme === 'file' ? minimatch(document.uri.fsPath, mapping.pattern, { dot: true }) : false;
      if (matchesRelative || matchesAbsolute) {
        const uri = this.resolveReferenceUri(document, mapping.schema);
        if (uri) {
          return { kind: 'uri', uri, cacheKey: `atlas:${mapping.pattern}:${uri.toString()}` };
        }
      }
    }
    return undefined;
  }

  private normalizeFileMatches(value: string[] | string | undefined): string[] {
    if (typeof value === 'string') {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
    return [];
  }

  private matchesAnyPattern(document: vscode.TextDocument, patterns: string[]): boolean {
    if (!patterns.length) {
      return true;
    }
    const relativePath = this.getDocumentRelativePath(document);
    for (const pattern of patterns) {
      if (pattern && relativePath && minimatch(relativePath, pattern, { dot: true })) {
        return true;
      }
      const fsPath = document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
      if (pattern && minimatch(fsPath, pattern, { dot: true })) {
        return true;
      }
    }
    return false;
  }

  private getDocumentRelativePath(document: vscode.TextDocument): string | undefined {
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    if (relative && relative !== document.uri.toString()) {
      return relative.split(path.sep).join('/');
    }
    if (document.uri.scheme === 'file') {
      return document.uri.fsPath.split(path.sep).join('/');
    }
    return undefined;
  }

  private resolveReferenceUri(document: vscode.TextDocument, reference: string): vscode.Uri | undefined {
    const trimmed = reference?.trim();
    if (!trimmed) {
      return undefined;
    }

    if (this.isAbsoluteUri(trimmed)) {
      const parsed = this.tryParseUri(trimmed);
      if (parsed) {
        return parsed;
      }
    }

    if (path.isAbsolute(trimmed)) {
      return vscode.Uri.file(trimmed);
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      const normalized = trimmed.replace(/^\.\/+/, '');
      const segments = normalized.split(/[\\/]+/).filter(Boolean);
      return vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
    }

    if (document.uri.scheme === 'file') {
      const dir = path.dirname(document.uri.fsPath);
      return vscode.Uri.file(path.join(dir, trimmed));
    }

    return undefined;
  }

  private tryParseUri(value: string): vscode.Uri | undefined {
    try {
      return vscode.Uri.parse(value);
    } catch {
      return undefined;
    }
  }

  private isAbsoluteUri(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.+-]*:\/\//.test(value);
  }

  private async loadSchema(source: SchemaSource): Promise<{ schema: unknown; fingerprint: string; text: string } | undefined> {
    if (source.kind === 'inline') {
      return { schema: source.schema, fingerprint: source.text, text: source.text };
    }

    try {
      const buffer = await this.readSchemaUri(source.uri);
      const text = this.decoder.decode(buffer);
      const schema = JSON.parse(text);
      return { schema, fingerprint: text, text };
    } catch (error) {
      this.warnOnce(`Failed to load schema from ${source.uri.toString()}: ${this.describeError(error)}`);
      return undefined;
    }
  }

  private async readSchemaUri(uri: vscode.Uri): Promise<Uint8Array> {
    if (uri.scheme === 'http' || uri.scheme === 'https') {
      return this.fetchRemoteSchema(uri);
    }
    return vscode.workspace.fs.readFile(uri);
  }

  private async fetchRemoteSchema(uri: vscode.Uri, redirectCount = 0): Promise<Uint8Array> {
    const client = uri.scheme === 'https' ? https : http;
    return new Promise<Uint8Array>((resolve, reject) => {
      const request = client.get(uri.toString(), (response) => {
        const { statusCode, headers } = response;
        if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location && redirectCount < 3) {
          response.resume();
          let redirected = this.tryParseUri(headers.location);
          if (!redirected) {
            try {
              const base = new URL(uri.toString());
              const resolved = new URL(headers.location, base);
              redirected = vscode.Uri.parse(resolved.toString());
            } catch {
              // ignore
            }
          }
          if (redirected) {
            this.fetchRemoteSchema(redirected, redirectCount + 1).then(resolve).catch(reject);
            return;
          }
          reject(new Error(`Invalid redirect location: ${headers.location}`));
          return;
        }
        if (statusCode && (statusCode < 200 || statusCode >= 300)) {
          reject(new Error(`HTTP ${statusCode}`));
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      request.on('error', reject);
    });
  }

  private async resolveSchemaSource(document: vscode.TextDocument, root: Node | undefined): Promise<SchemaSource | undefined> {
    const embedded = this.getEmbeddedSchemaReference(root);
    if (embedded) {
      const uri = this.resolveReferenceUri(document, embedded);
      if (uri) {
        return { kind: 'uri', uri, cacheKey: uri.toString() };
      }
    }

    const assigned = await this.associationStore?.getSchemaReference(document.uri);
    if (assigned) {
      const uri = this.resolveReferenceUri(document, assigned);
      if (uri) {
        return { kind: 'uri', uri, cacheKey: `assignment:${document.uri.toString()}` };
      }
    }

    const jsonConfigSource = this.resolveFromJsonSchemasConfig(document);
    if (jsonConfigSource) {
      return jsonConfigSource;
    }

    const atlasSource = this.resolveFromAtlasConfig(document);
    if (atlasSource) {
      return atlasSource;
    }

    this.warnOnce(`JSON Atlas could not find a schema for ${document.uri.fsPath}. Use "JSON Atlas: Associate Schema" to pick one.`);
    return undefined;
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
