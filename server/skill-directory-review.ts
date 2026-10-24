import type { SkillDirectoryReviewWire } from "../shared/skill-directory.ts";
import { skillDirectorySha256, skillFileDescriptor, type SkillFile } from "./skill-files.ts";

export function skillDirectoryReview(files: SkillFile[], endpoint: string): SkillDirectoryReviewWire {
  return { directorySha256: skillDirectorySha256(files), files: files.map(file => ({ ...skillFileDescriptor(file),
    ...(file.encoding ? {} : { content: file.content }), download: `${endpoint}/files?path=${encodeURIComponent(file.path)}`,
  })) };
}
