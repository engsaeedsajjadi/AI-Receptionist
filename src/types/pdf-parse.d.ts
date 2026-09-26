declare module "pdf-parse" {
  type PdfParseResult = {
    text: string;
    numpages: number;
    info?: unknown;
  };
  function pdfParse(data: Buffer | Uint8Array, options?: unknown): Promise<PdfParseResult>;
  export default pdfParse;
}
