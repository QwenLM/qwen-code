export interface PromptImage {
  data: string;
  media_type: string;
}

export interface PromptFile {
  name: string;
  media_type: string;
  text: string;
  size?: number;
}
