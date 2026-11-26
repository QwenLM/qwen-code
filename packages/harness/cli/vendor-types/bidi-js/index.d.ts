export default function bidiJs(): {
  getEmbeddingLevels: (
    text: string,
    defaultDirection?: string,
  ) => { levels: number[] };
  getBidiText: (text: string, defaultDirection?: string) => any;
  getReorderedSegments: (text: string, defaultDirection?: string) => any;
  getVisualFromLogical: (text: string, defaultDirection?: string) => any;
};
