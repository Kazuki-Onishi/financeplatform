import type { ReactElement, SVGProps } from "react";
import clsx from "clsx";

export type UploadGlyphName = "information" | "dropzone" | "queue" | "activity";

interface UploadGlyphProps extends SVGProps<SVGSVGElement> {
  name: UploadGlyphName;
  className?: string;
}

export function UploadGlyph({ name, className, ...props }: UploadGlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx("size-5", className)}
      {...props}
    >
      {GLYPHS[name]}
    </svg>
  );
}

const GLYPHS: Record<UploadGlyphName, ReactElement> = {
  information: (
    <>
      <rect x={6} y={4} width={12} height={16} rx={2.4} />
      <path d="M9 2.8h6" />
      <path d="M9 9h6" />
      <path d="M9 13h4" />
    </>
  ),
  dropzone: (
    <>
      <path d="M12 18V7" />
      <path d="M7.5 11.5 12 7l4.5 4.5" />
      <path d="M5 18h14" />
    </>
  ),
  queue: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h10" />
      <circle cx={18} cy={17} r={1.8} />
    </>
  ),
  activity: (
    <>
      <path d="M4 16.5 8.5 11l4 3.5L16.5 8l3.5 4.5" />
      <path d="M4 20h16" />
    </>
  ),
};
