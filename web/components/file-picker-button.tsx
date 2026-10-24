"use client";

import { useRef } from "react";

import { Button } from "@/components/ui/button";

// One visible button that opens the system's file dialog. The browser's own file input was
// restyled to plain text by Tailwind's base styles, so on macOS and Linux people saw no button and
// pressed the "Add" button next to it, which stayed disabled until a file was chosen (first
// experiments, 2026-10-24). The input stays in the page, hidden, so the dialog is the system's.
export function FilePickerButton({
  label,
  accept,
  multiple = false,
  disabled = false,
  variant = "outline",
  onPick,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  variant?: "default" | "outline";
  onPick: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button type="button" variant={variant} disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        multiple={multiple}
        accept={accept}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) onPick(event.target.files);
          // Cleared so that choosing the same file again, after removing it, adds it back.
          event.target.value = "";
        }}
      />
    </>
  );
}
