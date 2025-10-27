import { Octokit } from "octokit";

export type GitHubIssueSummary = {
  id: string;
  number: number;
  title: string;
  updatedAt: string;
};

export type GitHubIssueComment = {
  author: string;
  body: string;
  createdAt: string;
  databaseId: number;
  id: string;
};

export type GitHubIssue = {
  body: string;
  createdAt: string;
  id: string;
  labels: string[];
  number: number;
  title: string;
  updatedAt: string;
  url: string;
};

export type GitHubIssueWithComments = {
  comments: GitHubIssueComment[];
  issue: GitHubIssue;
};

export type GitHubPullRequestSummary = {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  body: string;
  labels: string[];
};

export type GitHubPullRequestDetails = GitHubPullRequestSummary & {
  url: string;
  author: string;
};

export type GitHubPullRequestIssueComment = {
  id: number;
  body: string;
  createdAt: string;
  author: string;
};

export type GitHubReviewComment = {
  id: number;
  body: string;
  createdAt: string;
  author: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  inReplyToId?: number;
};

export type GitHubAssociatedIssueComment = {
  id: string;
  createdAt: string;
  author: string;
  body: string;
};

export type GitHubAssociatedIssue = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  comments: GitHubAssociatedIssueComment[];
};

type ListIssuesQueryResult = {
  repository: {
    issues: {
      nodes: Array<{
        id: string;
        number: number;
        title: string;
        updatedAt: string;
      }>;
    };
  } | null;
};

type IssueWithCommentsQueryResult = {
  repository: {
    issue:
      | (
        & {
          body: string;
          createdAt: string;
          id: string;
          labels: {
            nodes: Array<{ name: string | null }>;
          };
          number: number;
          title: string;
          updatedAt: string;
          url: string;
        }
        & {
          comments: {
            nodes: Array<{
              author: { login: string | null } | null;
              body: string;
              createdAt: string;
              databaseId: number;
              id: string;
            }>;
            pageInfo: { endCursor: string | null; hasNextPage: boolean };
          };
        }
      )
      | null;
  } | null;
};

type AddIssueCommentResult = {
  addComment: {
    commentEdge: {
      node: {
        id: string;
      } | null;
    } | null;
  } | null;
};

type AssociatedIssuesQuery = {
  repository: {
    pullRequest: {
      closingIssuesReferences: {
        nodes: Array<
          {
            number: number;
            title: string;
            body: string | null;
            createdAt: string;
            updatedAt: string;
            labels: {
              nodes: Array<{ name: string | null } | null> | null;
            } | null;
            comments: {
              nodes:
                | Array<
                  {
                    id: string;
                    databaseId: number | null;
                    body: string;
                    createdAt: string;
                    author: { login: string | null } | null;
                  } | null
                >
                | null;
            } | null;
          } | null
        >;
      };
    } | null;
  } | null;
};

type GraphQLRequest = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<unknown>;

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly graphql: GraphQLRequest;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
    this.graphql = this.octokit.graphql.defaults({
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }) as GraphQLRequest;
  }

  async listOpenIssues(owner: string, repo: string, limit = 50): Promise<GitHubIssueSummary[]> {
    const data = await this.graphql(
      `query OpenIssues($owner: String!, $repo: String!, $limit: Int!) {
        repository(owner: $owner, name: $repo) {
          issues(first: $limit, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              id
              number
              title
              updatedAt
            }
          }
        }
      }`,
      { owner, repo, limit },
    ) as ListIssuesQueryResult;
    const nodes = data.repository?.issues.nodes ?? [];
    return nodes.map((node) => ({
      id: node.id,
      number: node.number,
      title: node.title,
      updatedAt: node.updatedAt,
    }));
  }

  async fetchIssueWithComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubIssueWithComments> {
    const comments: GitHubIssueComment[] = [];
    let issue: GitHubIssue | null = null;
    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await this.graphql(
        `query IssueWithComments(
          $owner: String!
          $repo: String!
          $number: Int!
          $after: String
        ) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              id
              number
              title
              body
              url
              createdAt
              updatedAt
              labels(first: 50) {
                nodes {
                  name
                }
              }
              comments(first: 50, after: $after) {
                nodes {
                  id
                  databaseId
                  body
                  createdAt
                  author {
                    login
                  }
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        }`,
        { owner, repo, number, after: cursor },
      ) as IssueWithCommentsQueryResult;
      const issueNode = data.repository?.issue;
      if (!issueNode) {
        throw new Error(`Issue #${number} not found in ${owner}/${repo}.`);
      }
      if (!issue) {
        issue = {
          body: issueNode.body ?? "",
          createdAt: issueNode.createdAt,
          id: issueNode.id,
          labels: issueNode.labels.nodes
            .map((node) => node.name)
            .filter((name): name is string => Boolean(name)),
          number: issueNode.number,
          title: issueNode.title,
          updatedAt: issueNode.updatedAt,
          url: issueNode.url,
        };
      }
      for (const node of issueNode.comments.nodes) {
        comments.push({
          author: node.author?.login ?? "unknown",
          body: node.body,
          createdAt: node.createdAt,
          databaseId: node.databaseId,
          id: node.id,
        });
      }
      hasNextPage = issueNode.comments.pageInfo.hasNextPage;
      cursor = issueNode.comments.pageInfo.endCursor;
    }
    if (!issue) {
      throw new Error("Failed to load issue details.");
    }
    return { issue, comments };
  }

  async addIssueComment(issueId: string, body: string) {
    await this.graphql(
      `mutation AddIssueComment($issueId: ID!, $body: String!) {
        addComment(input: { subjectId: $issueId, body: $body }) {
          commentEdge {
            node {
              id
            }
          }
        }
      }`,
      { issueId, body },
    ) as AddIssueCommentResult;
  }

  async listOpenPullRequests(
    owner: string,
    repo: string,
    limit = 32,
  ): Promise<GitHubPullRequestSummary[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: limit,
      sort: "updated",
      direction: "desc",
    });
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      body: pr.body ?? "",
      labels: (pr.labels ?? []).flatMap((label) => {
        if (typeof label === "string") return [label];
        if (label?.name) return [label.name];
        return [];
      }),
    }));
  }

  async fetchPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubPullRequestDetails> {
    const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: number });
    return {
      number: pr.number,
      title: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      body: pr.body ?? "",
      labels: (pr.labels ?? []).flatMap((label) => {
        if (typeof label === "string") return [label];
        if (label?.name) return [label.name];
        return [];
      }),
      url: pr.html_url,
      author: pr.user?.login ?? "unknown",
    };
  }

  async fetchPullRequestComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<{
    issueComments: GitHubPullRequestIssueComment[];
    reviewComments: GitHubReviewComment[];
  }> {
    const [issueResponse, reviewResponse] = await Promise.all([
      this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: 100,
        direction: "asc",
        sort: "created",
      }),
      this.octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
        direction: "asc",
        sort: "created",
      }),
    ]);
    const issueComments = issueResponse.data.map((comment) => ({
      id: comment.id,
      body: (comment.body ?? "").trim(),
      createdAt: comment.created_at,
      author: comment.user?.login ?? "unknown",
    }));
    const reviewComments = reviewResponse.data.map((comment) => ({
      id: comment.id,
      body: comment.body.trim(),
      createdAt: comment.created_at,
      author: comment.user?.login ?? "unknown",
      path: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      originalLine: comment.original_line ?? null,
      inReplyToId: comment.in_reply_to_id ?? undefined,
    }));
    return { issueComments, reviewComments };
  }

  async fetchAssociatedIssues(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GitHubAssociatedIssue[]> {
    try {
      const response = await this.graphql(
        `query AssociatedIssues($owner: String!, $repo: String!, $prNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $prNumber) {
              closingIssuesReferences(first: 8) {
                nodes {
                  number
                  title
                  body
                  createdAt
                  updatedAt
                  labels(first: 16) {
                    nodes {
                      name
                    }
                  }
                  comments(first: 100) {
                    nodes {
                      id
                      databaseId
                      body
                      createdAt
                      author {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { owner, repo, prNumber },
      ) as AssociatedIssuesQuery;
      const nodes = response.repository?.pullRequest?.closingIssuesReferences.nodes ?? [];
      return nodes
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
        .map((node) => {
          const labels = node.labels?.nodes?.flatMap((label) => {
            if (!label?.name) return [];
            return [label.name];
          }) ?? [];
          const comments = node.comments?.nodes?.flatMap((comment) => {
            if (!comment) return [];
            const id = comment.databaseId != null ? comment.databaseId.toString() : comment.id;
            const body = (comment.body ?? "No body.").trim();
            return [{
              id,
              createdAt: comment.createdAt,
              author: comment.author?.login ?? "unknown",
              body: body.length > 0 ? body : "No body.",
            }];
          }) ?? [];
          return {
            number: node.number,
            title: node.title,
            body: (node.body ?? "No body.").trim(),
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
            labels,
            comments,
          };
        });
    } catch (error) {
      console.warn("Failed to fetch associated issues:", error);
      return [];
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: { base: string; head: string; title: string; body: string },
  ): Promise<{ url: string }> {
    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      base: params.base,
      head: params.head,
      title: params.title,
      body: params.body,
    });
    return { url: data.html_url };
  }
}

export function createGitHubClient(token: string): GitHubClient {
  if (!token) {
    throw new Error("GitHub token is required to create a client.");
  }
  return new GitHubClient(token);
}
