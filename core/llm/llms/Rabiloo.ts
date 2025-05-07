import {
  Chunk,
  LLMOptions
} from "../../index.js";

import { BaseLLM } from "../index";

class Rabiloo extends BaseLLM {
  static providerName = "rabiloo";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://192.168.20.198:8001",
    model: "nomic-embed-text",
  };
  
  protected async _embed(chunks: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const queries: string[] = [
        'Calculate the n-th factorial',
        // 'summit define'
    ];
    const prefixed_query: string = "Represent this query for searching relevant code: ";
    const modifiedQueries: string[] = queries.map(query => prefixed_query + query);
    const resp = await this.fetch(new URL("v1/embeddings", this.apiBase), {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        input: [...modifiedQueries, ...chunks],
        encoding_format: "float",
      }),
      headers: headers,
    });
    if (!resp.ok) {
      throw new Error(`Failed to embed chunk: ${await resp.text()}`);
    }
    const data = await resp.json();
    const embeddings: number[][] = data.data.map((result: { embedding: number[] }) => result.embedding);

    if (!embeddings || embeddings.length === 0) {
      throw new Error("Model generated empty embedding");
    }
    return embeddings;
  }

  async rerank(query: string, chunks: Chunk[]): Promise<number[]> {
      const resp = await this.fetch(new URL("v1/score", this.apiBase), {
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

export default Rabiloo;