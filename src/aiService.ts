import * as vscode from 'vscode';
import { CoreMessage, LanguageModel, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { SchemaInfo } from './schemaValidator';

const MODEL_STORAGE_KEY = 'jsonAtlas.aiModel';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_CONTEXT_CHARS = 20000;

type AiProvider = 'openai' | 'anthropic';

interface ProviderConfig {
  label: string;
  secretKey: string;
  createClient: (apiKey: string) => (modelId: string) => LanguageModel;
}

const PROVIDER_CONFIG: Record<AiProvider, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    secretKey: 'jsonAtlas.openaiKey',
    createClient: (apiKey: string) => createOpenAI({ apiKey })
  },
  anthropic: {
    label: 'Anthropic',
    secretKey: 'jsonAtlas.anthropicKey',
    createClient: (apiKey: string) => createAnthropic({ apiKey })
  }
};

export interface AiModelOption {
  id: string;
  label: string;
  description?: string;
  provider: AiProvider;
}

const MODEL_OPTIONS: AiModelOption[] = [
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o Mini',
    description: 'Fast, low-latency responses',
    provider: 'openai'
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    description: 'Higher quality reasoning',
    provider: 'openai'
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    description: 'Latest lightweight 4.1 series',
    provider: 'openai'
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
    description: 'Cutting-edge model with advanced capabilities',
    provider: 'openai'
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    label: 'Claude 3.5 Sonnet',
    description: "Anthropic's flagship reasoning model",
    provider: 'anthropic'
  },
  {
    id: 'claude-3-5-haiku-20241022',
    label: 'Claude 3.5 Haiku',
    description: 'Faster, cost-efficient Anthropic responses',
    provider: 'anthropic'
  },
  {
    id: 'claude-4.1-haiku',
    label: 'Claude 4.1 Haiku',
    description: 'Fastest Claude 4.1 model optimized for low latency',
    provider: 'anthropic'
  },
  {
    id: 'claude-4.1-sonnet',
    label: 'Claude 4.1 Sonnet',
    description: 'Balanced Claude 4.1 model for high quality and speed',
    provider: 'anthropic'
  },
  {
    id: 'claude-4.1-opus',
    label: 'Claude 4.1 Opus',
    description: 'Highest-capability Claude 4.1 model',
    provider: 'anthropic'
  }
];

export interface StreamCallbacks {
  onStart?: () => void;
  onDelta?: (delta: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: unknown) => void;
}

export interface EditProposal {
  title: string;
  summary: string;
  updatedJson: string;
}

export interface SchemaUpdateProposal {
  title: string;
  summary: string;
  updatedSchema: string;
}

export class AiService {
  private readonly modelChangedEmitter = new vscode.EventEmitter<AiModelOption>();
  public readonly onModelChanged = this.modelChangedEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public getModelOptions(): AiModelOption[] {
    return MODEL_OPTIONS;
  }

  public getSelectedModelOption(): AiModelOption {
    const activeId = this.getSelectedModelId();
    return MODEL_OPTIONS.find((option) => option.id === activeId) ?? MODEL_OPTIONS[0];
  }

  public getSelectedModelId(): string {
    const stored = this.context.globalState.get<string>(MODEL_STORAGE_KEY);
    if (stored && MODEL_OPTIONS.some((option) => option.id === stored)) {
      return stored;
    }
    return DEFAULT_MODEL;
  }

  public async setSelectedModel(modelId: string): Promise<AiModelOption | undefined> {
    const option = MODEL_OPTIONS.find((candidate) => candidate.id === modelId);
    if (!option) {
      return undefined;
    }
    await this.context.globalState.update(MODEL_STORAGE_KEY, option.id);
    this.modelChangedEmitter.fire(option);
    return option;
  }

  public async promptForApiKey(provider?: AiProvider): Promise<void> {
    const target = provider ?? (await this.pickProvider('Select a provider to configure an API key for'));
    if (!target) {
      return;
    }

    const config = PROVIDER_CONFIG[target];
    const existing = await this.context.secrets.get(config.secretKey);
    const key = await vscode.window.showInputBox({
      title: `Enter ${config.label} API key`,
      prompt: `Paste your ${config.label} API key. It will be stored securely and used for AI features.`,
      ignoreFocusOut: true,
      password: true,
      value: existing ?? ''
    });

    if (!key) {
      return;
    }

    await this.context.secrets.store(config.secretKey, key.trim());
    void vscode.window.showInformationMessage(`${config.label} API key saved for JSON Atlas.`);
  }

  public async clearApiKey(provider?: AiProvider): Promise<void> {
    const target = provider ?? (await this.pickProvider('Select a provider to remove its API key'));
    if (!target) {
      return;
    }

    const config = PROVIDER_CONFIG[target];
    await this.context.secrets.delete(config.secretKey);
    void vscode.window.showInformationMessage(`${config.label} API key removed for JSON Atlas.`);
  }

  public async hasApiKey(provider?: AiProvider): Promise<boolean> {
    const target = provider ?? this.getSelectedModelOption().provider;
    const config = PROVIDER_CONFIG[target];
    const key = await this.context.secrets.get(config.secretKey);
    return Boolean(key);
  }

  public async summarizeDocument(document: vscode.TextDocument, textOverride?: string): Promise<string | undefined> {
    const model = this.getSelectedModelOption();
    const apiKey = await this.ensureProviderKey(model.provider);
    if (!apiKey) {
      return undefined;
    }

    const client = PROVIDER_CONFIG[model.provider].createClient(apiKey);
    const text = textOverride ?? document.getText();
    const truncated = truncate(text, MAX_CONTEXT_CHARS);

    const result = await streamText({
      model: client(model.id),
      messages: [
        {
          role: 'system',
          content: [
            'You summarize JSON documents for developers.',
            'Always respond in markdown with two sections in this exact order:',
            '1. **Key Insights** — 3-6 concise bullet points calling out the most important takeaways.',
            '2. **Structure** — bullet lists highlighting notable objects, arrays, or nested data. Mention key names in **bold**.',
            'Keep wording tight and avoid repeating the same fact in both sections.'
          ].join(' ')
        },
        {
          role: 'user',
          content: `Summarize this JSON:\n${truncated}`
        }
      ]
    });

    const summary = await result.text;
    return summary.trim();
  }

  public async explainSelection(payload: { selectionText: string; jsonPath?: string }): Promise<string | undefined> {
    const snippet = payload.selectionText?.trim();
    if (!snippet) {
      return undefined;
    }

    const model = this.getSelectedModelOption();
    const apiKey = await this.ensureProviderKey(model.provider);
    if (!apiKey) {
      return undefined;
    }

    const client = PROVIDER_CONFIG[model.provider].createClient(apiKey);
    const truncated = truncate(snippet, MAX_CONTEXT_CHARS);
    const pathLine = payload.jsonPath ? `JSON path: ${payload.jsonPath}` : 'Selected JSON:';

    const result = await streamText({
      model: client(model.id),
      messages: [
        {
          role: 'system',
          content: [
            'You explain targeted JSON selections for developers.',
            'Respond in markdown with two sections in this order:',
            '1. **What it represents** — summarize intent, relationships, and real-world meaning.',
            '2. **Details** — bullet list calling out important keys, arrays, constraints, or notable values.',
            'Reference the provided JSON path when present.'
          ].join(' ')
        },
        {
          role: 'user',
          content: [pathLine, '', truncated, '', 'Explain this selection clearly for a developer.'].join('\n')
        }
      ]
    });

    const explanation = await result.text;
    return explanation.trim();
  }

  public async generateEditProposals(document: vscode.TextDocument, signal?: AbortSignal): Promise<EditProposal[]> {
    const model = this.getSelectedModelOption();
    const apiKey = await this.ensureProviderKey(model.provider);
    if (!apiKey) {
      return [];
    }

    const client = PROVIDER_CONFIG[model.provider].createClient(apiKey);
    const text = document.getText();
    const truncated = truncate(text, MAX_CONTEXT_CHARS);

    const result = await streamText({
      model: client(model.id),
      temperature: 0.25,
      abortSignal: signal,
      messages: [
        {
          role: 'system',
          content: [
            'You analyze JSON documents and propose concrete edits.',
            'Respond with strict JSON using the following schema:',
            '{"proposals":[{"title":"string","summary":"string","updatedJson":"string"}]}',
            'Each proposal should explain the benefit and include the full updated JSON after applying the change.'
          ].join(' ')
        },
        {
          role: 'user',
          content: `Document:\n${truncated}\nGenerate up to 4 thoughtful improvement proposals.`
        }
      ]
    });

    const raw = await result.text;
    return this.parseEditProposals(raw);
  }

  public async generateSchemaProposals(
    document: vscode.TextDocument,
    schemaInfo: SchemaInfo,
    signal?: AbortSignal
  ): Promise<SchemaUpdateProposal[]> {
    const model = this.getSelectedModelOption();
    const apiKey = await this.ensureProviderKey(model.provider);
    if (!apiKey) {
      return [];
    }

    const client = PROVIDER_CONFIG[model.provider].createClient(apiKey);
    const sampleJson = truncate(document.getText(), Math.floor(MAX_CONTEXT_CHARS / 2));
    const schemaText = truncate(schemaInfo.schemaText, Math.floor(MAX_CONTEXT_CHARS / 2));

    const result = await streamText({
      model: client(model.id),
      temperature: 0.2,
      abortSignal: signal,
      messages: [
        {
          role: 'system',
          content: [
            'You are an expert JSON Schema engineer.',
            'Given the current schema and representative JSON documents, propose targeted schema updates.',
            'Respond with strict JSON matching this shape:',
            '{"proposals":[{"title":"string","summary":"string","updatedSchema":"string"}]}',
            'The updatedSchema must contain the complete schema after applying the change. Preserve formatting where practical.'
          ].join(' ')
        },
        {
          role: 'user',
          content: [
            `Existing schema (from ${schemaInfo.uri.fsPath}):`,
            schemaText,
            '',
            `Sample JSON document (${document.uri.fsPath}):`,
            sampleJson,
            '',
            'Suggest up to 3 improvements (new enums, required props, oneOf branches, constraints).',
            'Only propose meaningful updates that keep the schema valid and backwards compatible where possible.'
          ].join('\n')
        }
      ]
    });

    const raw = await result.text;
    return this.parseSchemaProposals(raw);
  }

  public async streamChat(options: {
    document: vscode.TextDocument;
    history: CoreMessage[];
    prompt: string;
    callbacks: StreamCallbacks;
  }): Promise<{ text?: string; error?: unknown }> {
    const model = this.getSelectedModelOption();
    const apiKey = await this.ensureProviderKey(model.provider, false);
    if (!apiKey) {
      return { error: new Error('missing_api_key') };
    }

    const client = PROVIDER_CONFIG[model.provider].createClient(apiKey);
    const documentText = truncate(options.document.getText(), MAX_CONTEXT_CHARS);
    const systemMessage: CoreMessage = {
      role: 'system',
      content: [
        'You are an AI assistant embedded inside a JSON visualizer.',
        'Help with JSON questions, editing instructions, and structural reasoning.',
        'When proposing edits, explain them clearly and include updated snippets in fenced ```json blocks when possible.',
        `Current document (possibly truncated):\n${documentText}`
      ].join('\n')
    };

    const messages: CoreMessage[] = [systemMessage, ...options.history, { role: 'user', content: options.prompt }];

    try {
      options.callbacks.onStart?.();

      const result = streamText({
        model: client(model.id),
        messages,
        temperature: 0.2
      });

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta' && chunk.text) {
          options.callbacks.onDelta?.(chunk.text);
        }
      }

      const full = await result.text;
      options.callbacks.onComplete?.(full);
      return { text: full };
    } catch (error) {
      options.callbacks.onError?.(error);
      return { error };
    }
  }

  public async ensureApiKey(interactive = true): Promise<string | undefined> {
    const model = this.getSelectedModelOption();
    return this.ensureProviderKey(model.provider, interactive);
  }

  private async ensureProviderKey(provider: AiProvider, interactive = true): Promise<string | undefined> {
    const config = PROVIDER_CONFIG[provider];
    let key = await this.context.secrets.get(config.secretKey);
    if (key) {
      return key;
    }

    if (!interactive) {
      return undefined;
    }

    await this.promptForApiKey(provider);
    key = await this.context.secrets.get(config.secretKey);
    return key ?? undefined;
  }

  private async pickProvider(placeHolder: string): Promise<AiProvider | undefined> {
    const selection = await vscode.window.showQuickPick(
      Object.entries(PROVIDER_CONFIG).map(([id, config]) => ({
        label: config.label,
        description: id === 'openai' ? 'OpenAI Platform' : 'Anthropic Claude',
        value: id as AiProvider
      })),
      { placeHolder }
    );
    return selection?.value;
  }

  private parseEditProposals(raw: string): EditProposal[] {
    const payload = this.extractJson(raw);
    if (!payload) {
      return [];
    }

    const rawProposals = Array.isArray(payload?.proposals)
      ? payload.proposals
      : Array.isArray(payload)
        ? payload
        : [];

    return (rawProposals as Array<Record<string, unknown>>)
      .map((entry, index) => {
        if (!entry) {
          return undefined;
        }
        const record = entry as { [key: string]: unknown };
        const rawTitle = record.title;
        const rawSummary = record.summary ?? record.reason;
        const rawJson = record.updatedJson ?? record.json ?? record.output;
        const title = typeof rawTitle === 'string' && rawTitle.trim().length ? rawTitle.trim() : `Proposal ${index + 1}`;
        const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
        const updatedJson = typeof rawJson === 'string' ? rawJson.trim() : '';
        if (!updatedJson) {
          return undefined;
        }
        return { title, summary, updatedJson } satisfies EditProposal;
      })
      .filter((proposal): proposal is EditProposal => Boolean(proposal));
  }

  private parseSchemaProposals(raw: string): SchemaUpdateProposal[] {
    const payload = this.extractJson(raw);
    if (!payload) {
      return [];
    }

    const rawProposals = Array.isArray(payload?.proposals)
      ? payload.proposals
      : Array.isArray(payload)
        ? payload
        : [];

    return (rawProposals as Array<Record<string, unknown>>)
      .map((entry, index) => {
        if (!entry) {
          return undefined;
        }
        const record = entry as { [key: string]: unknown };
        const rawTitle = record.title;
        const rawSummary = record.summary ?? record.reason;
        const rawSchema = record.updatedSchema ?? record.schema ?? record.output;
        const title = typeof rawTitle === 'string' && rawTitle.trim().length ? rawTitle.trim() : `Schema Proposal ${index + 1}`;
        const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
        const updatedSchema = typeof rawSchema === 'string' ? rawSchema.trim() : '';
        if (!updatedSchema) {
          return undefined;
        }
        return { title, summary, updatedSchema } satisfies SchemaUpdateProposal;
      })
      .filter((proposal): proposal is SchemaUpdateProposal => Boolean(proposal));
  }

  private extractJson(raw: string): any {
    try {
      return JSON.parse(raw);
    } catch {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const slice = raw.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }
}

function truncate(text: string, max: number) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n[truncated]`;
}
