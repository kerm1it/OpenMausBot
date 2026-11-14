export type AvatarKind = "bot" | "person";
export type AvatarDrawn = "picture" | "mascot" | "initials";

export function avatarMarks(kind: AvatarKind | undefined, drawn: AvatarDrawn): { "data-avatar"?: AvatarDrawn; "data-avatar-kind"?: AvatarKind } {
  return kind ? { "data-avatar": drawn, "data-avatar-kind": kind } : {};
}
