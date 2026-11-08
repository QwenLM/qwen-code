export interface PromptImage {
  data: string;
  media_type: string;
}

export interface PromptFile {
  name: string;
  media_type: string;
  data?: Blob;
  text?: string;
  size?: number;
  attachmentId?: string;
}
