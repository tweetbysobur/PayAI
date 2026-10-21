/** One segment per share: filled once paid. */
export function Segments({ paid, target, className = "" }: { paid: number; target: number; className?: string }) {
  return (
    <span aria-hidden className={`flex gap-1 ${className}`}>
      {Array.from({ length: target }, (_, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${i < paid ? "bg-primary" : "bg-input"}`} />
      ))}
    </span>
  );
}
