export const appName = "Suri Pi";
export const appIcon = "/icon.svg";

/** Decode SVG as an isolated image, retaining alpha on a transparent canvas. */
export async function prepareIconUpload(file: File): Promise<File> {
  if (
    file.type !== "image/svg+xml" &&
    !file.name.toLowerCase().endsWith(".svg")
  )
    return file;
  if (file.size > 1048576) throw Error("Icon exceeds the 1 MiB size limit.");
  const url = URL.createObjectURL(
    new Blob([await file.arrayBuffer()], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw Error("SVG icon could not be decoded.");
    });
    const width = image.naturalWidth || 300;
    const height = image.naturalHeight || 150;
    const scale = Math.min(1, 512 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw Error("Icon conversion is unavailable.");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(Error("SVG icon could not be converted.")),
        "image/png",
      ),
    );
    return new File([png], file.name.replace(/\.svg$/i, "") + ".png", {
      type: "image/png",
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
