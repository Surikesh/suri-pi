import { FolderIcon } from "../../icons.js";
import { classifyFileType, DshFileIcon } from "../../dsh-file-icons.js";

export function fileType(path: string) {
  return { kind: classifyFileType(path) };
}
export function FileTypeIcon({
  path,
  directory = false,
}: {
  path: string;
  directory?: boolean;
}) {
  if (directory)
    return (
      <span className="file-type-icon directory" aria-hidden="true">
        <FolderIcon />
      </span>
    );
  const type = fileType(path);
  return (
    <span className={`file-type-icon ${type.kind}`} aria-hidden="true">
      <DshFileIcon kind={type.kind} size={20} />
    </span>
  );
}
