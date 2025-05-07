import {
  Chunk,
  LLMOptions
} from "../../index.js";

import OpenAI from "./OpenAI.js";

class Vllm extends OpenAI {
  static providerName = "vllm";
  constructor(options: LLMOptions) {
    super(options);

    if (options.model === "AUTODETECT") {
      this._setupCompletionOptions();
    }
  }

  private _setupCompletionOptions() {
    this.fetch(this._getEndpoint("models"), {
      method: "GET",
      headers: this._getHeaders(),
    })
      .then(async (response) => {
        if (response.status !== 200) {
          console.warn(
            "Error calling vLLM /models endpoint: ",
            await response.text(),
          );
          return;
        }
        const json = await response.json();
        const data = json.data[0];
        this.model = data.id;
        this.contextLength = Number.parseInt(data.max_model_len);
      })
      .catch((e) => {
        console.log(`Failed to list models for vLLM: ${e.message}`);
      });
  }

  async rerank(query: string, chunks: Chunk[]): Promise<number[]> {
        const resp = await this.fetch(new URL("score", this.apiBase), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            text_1: query,
            text_2: chunks.map((chunk) => chunk.content),
            encoding_format: "float",
          }),
        });
    
        if (!resp.ok) {
          throw new Error(await resp.text());
        }
    
        const data = (await resp.json()) as any;
        const results = data.data.sort((a: any, b: any) => a.index - b.index);
        return results.map((result: any) => result.score);
      }
}

export default Vllm;
