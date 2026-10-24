/** An issue as GitHub reports it. */
export interface Issue {
  /** Repository as `<owner>/<name>`. */
  repository: string;
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  labels: string[];
  url: string;
}

/** Which issues of a repository match. All conditions must hold. */
export interface IssueFilter {
  /** Repository as `<owner>/<name>`. */
  repository: string;
  /** The issue carries every one of these labels. Defaults to none. */
  labels?: string[];
  /** Defaults to `open`. */
  state?: "open" | "closed" | "all";
}

/** Reads the issues of a repository; the GitHub REST API client implements it. */
export interface IssueTracker {
  /**
   * Issues of `filter.repository` that carry every label in `filter.labels` and are in
   * `filter.state` (default `open`; `all` for both), ordered by number.
   */
  findIssues(filter: IssueFilter): Promise<Issue[]>;
}
