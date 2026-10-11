import { IModelProvider, ModelInfo, GenerationOptions, GenerationResult } from '../types.js';
import { OfflineCognitiveEngine } from './OfflineCognitiveEngine.js';
import { OllamaProvider } from './OllamaProvider.js';
import { GeminiCoprocessorProvider } from './GeminiCoprocessorProvider.js';
import { MemoryStore } from '../storage/MemoryStore.js';
import { ToolExecutor } from '../tools/ToolExecutor.js';

export class ProviderRegistry {
  private offlineEngine: OfflineCognitiveEngine;
  private ollamaProvider: OllamaProvider;
  private geminiProvider: GeminiCoprocessorProvider;
  private preferredProviderId: string = 'rare-offline-cognitive';

  constructor(memoryStore: MemoryStore, toolExecutor: ToolExecutor) {
    this.offlineEngine = new OfflineCognitiveEngine(memoryStore, toolExecutor);
    this.ollamaProvider = new OllamaProvider();
    this.geminiProvider = new GeminiCoprocessorProvider();
  }

  public setPreferredProvider(id: string): void {
    this.preferredProviderId = id;
  }

  public getPreferredProvider(): string {
    return this.preferredProviderId;
  }

  public async getAllProviders(): Promise<ModelInfo[]> {
    const list = await Promise.all([
      this.offlineEngine.getInfo(),
      this.ollamaProvider.getInfo(),
      this.geminiProvider.getInfo(),
    ]);
    return list;
  }

  public async getActiveProvider(): Promise<{ provider: IModelProvider; info: ModelInfo }> {
    // 1. If user explicitly preferred local Ollama or Ollama is online and preferred
    if (this.preferredProviderId === 'local-ollama' && (await this.ollamaProvider.isAvailable())) {
      return {
        provider: this.ollamaProvider,
        info: await this.ollamaProvider.getInfo(),
      };
    }

    // 2. If user explicitly preferred Gemini coprocessor
    if (this.preferredProviderId === 'gemini-coprocessor' && (await this.geminiProvider.isAvailable())) {
      return {
        provider: this.geminiProvider,
        info: await this.geminiProvider.getInfo(),
      };
    }

    // 3. Check if local Ollama daemon is detected and available
    if (await this.ollamaProvider.isAvailable()) {
      return {
        provider: this.ollamaProvider,
        info: await this.ollamaProvider.getInfo(),
      };
    }

    // 4. Default: RARE Native Offline Cognitive Engine (Zero External API Key required)
    return {
      provider: this.offlineEngine,
      info: await this.offlineEngine.getInfo(),
    };
  }

  public async generate(
    prompt: string,
    context?: string,
    options?: GenerationOptions
  ): Promise<GenerationResult> {
    // Attempt with active provider, with guaranteed fallback to offline engine
    const { provider } = await this.getActiveProvider();
    try {
      return await provider.generate(prompt, context, options);
    } catch (err) {
      console.warn('[ProviderRegistry] Primary provider failed, falling back to Offline Cognitive Engine:', err);
      return await this.offlineEngine.generate(prompt, context, options);
    }
  }

  public getOfflineEngine(): OfflineCognitiveEngine {
    return this.offlineEngine;
  }
}
