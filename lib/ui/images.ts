import type { Attachment } from "@/lib/types";
import { uid } from "./format";

export const MAX_IMAGE_SIDE = 1600;
export const MAX_ATTACHMENTS = 8;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const IMAGE_ACCEPT = ACCEPTED.join(",");

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the image."));
    img.src = src;
  });
}

// Reads an image file and scales it down so the long side is at most 1600 px.
// PNG stays PNG so screenshots keep sharp text. Other formats become JPEG.
export async function imageToAttachment(file: File): Promise<Attachment> {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error(
      `${file.name || "This file"} is not a supported image. You can attach PNG, JPEG, WebP or GIF images.`,
    );
  }
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  const name = file.name || `pasted-image.${file.type.split("/")[1] ?? "png"}`;

  if (long <= MAX_IMAGE_SIDE && file.type !== "image/gif") {
    return { id: uid(), name, mediaType: file.type, dataUrl: original };
  }

  const scale = Math.min(1, MAX_IMAGE_SIDE / long);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not resize the image.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);

  const keepPng = file.type === "image/png" || file.type === "image/gif";
  const mediaType = keepPng ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(mediaType, keepPng ? undefined : 0.9);
  const renamed = keepPng ? name.replace(/\.gif$/i, ".png") : name.replace(/\.(webp|png|gif)$/i, ".jpg");
  return { id: uid(), name: renamed, mediaType, dataUrl };
}

// Converts a list of files and collects a plain error message for any that fail.
export async function filesToAttachments(
  files: File[],
  room: number,
): Promise<{ attachments: Attachment[]; error?: string }> {
  const images = files.slice(0, Math.max(0, room));
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  for (const file of images) {
    try {
      attachments.push(await imageToAttachment(file));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "An image could not be read.");
    }
  }
  if (files.length > images.length) {
    errors.push(`You can attach up to ${MAX_ATTACHMENTS} images to one message.`);
  }
  return { attachments, error: errors[0] };
}

export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
