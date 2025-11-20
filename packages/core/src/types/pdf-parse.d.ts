declare module 'pdf-parse' {
  export default function pdfParse(input: Buffer | ArrayBuffer): Promise<{
    numpages: number;
    numrender: number;
    info: {
      PDFFormatVersion: string;
      Title?: string;
      Producer?: string;
      Creator?: string;
      CreationDate?: string;
      ModDate?: string;
    };
    metadata: {
      info: {
        Title?: string;
        Author?: string;
        Subject?: string;
        Keywords?: string;
        Creator?: string;
        Producer?: string;
        CreationDate?: string;
        ModDate?: string;
      };
      metadata: string; // XML metadata string if available
      pages: number;
    } | null;
    text: string;
  }>;
}
