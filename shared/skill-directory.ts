/** Reviewed directory contents; binary bytes are downloaded separately from the scoped file endpoint. */
export interface SkillDirectoryFileWire {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  binary: boolean;
  content?: string;
  download?: string;
}

/** The digest binds all file names, bytes and executable flags shown during review. */
export interface SkillDirectoryReviewWire {
  files?: SkillDirectoryFileWire[];
  directorySha256?: string;
}
