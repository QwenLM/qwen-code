export interface EmbeddedManagerPage {
  onRoot: () => void;
  onDetailChange: (open: boolean) => void;
  onBack?: () => void;
}
