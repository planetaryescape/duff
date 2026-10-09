import { Context, Effect, Schema } from "effect";

export const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));
export const GitPath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\u0000).+$/s),
);

export const FileChange = Schema.Struct({
  status: Schema.Literals(["A", "M", "D", "R", "C", "T"]),
  path: GitPath,
  previousPath: Schema.optional(GitPath),
});
export interface FileChange extends Schema.Schema.Type<typeof FileChange> {}

export const Review = Schema.Struct({
  root: Schema.String,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  baseCommit: Commit,
  headCommit: Commit,
  files: Schema.Array(FileChange),
});
export interface Review extends Schema.Schema.Type<typeof Review> {}

export const Snapshot = Schema.Struct({
  root: Schema.String,
  commit: Commit,
  path: Schema.optional(GitPath),
});
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class BranchReview extends Context.Service<BranchReview, {
  readonly branches: (directory: string) => Effect.Effect<{
    readonly root: string;
    readonly current: string;
    readonly branches: ReadonlyArray<string>;
  }, ReviewError>;
  readonly compare: (root: string, branch: string) => Effect.Effect<Review, ReviewError>;
  readonly read: (snapshot: Snapshot) => Effect.Effect<string, ReviewError>;
}>()("duff/BranchReview") {}
