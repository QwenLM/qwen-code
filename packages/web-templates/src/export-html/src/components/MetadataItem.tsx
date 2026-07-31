export type MetadataItemProps = {
  label: string;
  value?: string | number;
  valueClass?: string;
};

export const MetadataItem = ({
  label,
  value,
  valueClass,
}: MetadataItemProps) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return (
    <div className="metadata-item">
      <div className="metadata-content">
        <span className="metadata-label">{label}</span>
        <span
          className={`metadata-value ${valueClass || ''}`}
          title={typeof value === 'string' ? value : undefined}
        >
          {value}
        </span>
      </div>
    </div>
  );
};
