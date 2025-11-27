export type IssueSummary = {
  id: string;
  title: string;
  labels: string[];
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  url?: string;
  number?: number;
};

export type Issue = IssueSummary & {
  body: string;
};

export type IssueComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
};

export type CreatePullRequestInput = {
  base: string;
  head: string;
  title: string;
  body: string;
};

export type CreatePullRequestResult = {
  id?: string;
  number?: number;
  url: string;
};

export type IssueBackendKind = "github" | "filesystem";

export interface IssueProvider {
  readonly kind: IssueBackendKind;
  listOpenIssues(): Promise<IssueSummary[]>;
  fetchIssueWithComments(id: string): Promise<{ issue: Issue; comments: IssueComment[] }>;
  addComment(issueId: string, body: string): Promise<void>;
  createPullRequest?(input: CreatePullRequestInput): Promise<CreatePullRequestResult | null>;
}
