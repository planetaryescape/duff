import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Layer, Schema } from "effect";
import { BranchReview, Commit, FileChange, Review, ReviewError, Snapshot } from "./review";

const execute = promisify(execFile);

const git = Effect.fn("GitReview.git")(function* (root: string, args: ReadonlyArray<string>) {
  const result = yield* Effect.tryPromise({
    try: (signal) => execute("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      signal,
    }),
    catch: () => new ReviewError({
      operation: args[0] ?? "git",
      message: "Git operation failed. Check that Git is installed, the repository has commits, and the selected branch is available locally. Raw diagnostics are hidden because they may contain private data.",
    }),
  });
  return result.stdout;
});

const decodeFiles = Effect.fn("GitReview.decodeFiles")(function* (output: string) {
  const tokens = output.split("\0");
  const files: FileChange[] = [];
  for (let index = 0; index < tokens.length - 1;) {
    const rawStatus = tokens[index++];
    const renamed = rawStatus?.startsWith("R") || rawStatus?.startsWith("C");
    const firstPath = tokens[index++];
    const path = renamed ? tokens[index++] : firstPath;
    const file = yield* Schema.decodeUnknownEffect(FileChange)({
      status: rawStatus?.charAt(0),
      path,
      ...(renamed ? { previousPath: firstPath } : {}),
    }).pipe(Effect.mapError(() => new ReviewError({
      operation: "decode changed files",
      message: "Git returned an unsupported file change.",
    })));
    files.push(file);
  }
  return files;
});

const commit = Effect.fn("GitReview.commit")(function* (root: string, ref: string) {
  const output = yield* git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  return yield* Schema.decodeUnknownEffect(Commit)(output.trim()).pipe(
    Effect.mapError(() => new ReviewError({ operation: "resolve commit", message: "Git returned an invalid commit ID." })),
  );
});

export const gitReviewLayer = Layer.effect(BranchReview, Effect.gen(function* () {
  const branches = Effect.fn("BranchReview.branches")(function* (directory: string) {
    const root = (yield* git(directory, ["rev-parse", "--show-toplevel"])).trim();
    const current = (yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const output = yield* git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
    return {
      root,
      current,
      branches: output.trim().split("\n").filter((ref) => ref && !ref.endsWith("/HEAD") && ref !== `refs/heads/${current}`),
    };
  });

  const compare = Effect.fn("BranchReview.compare")(function* (root: string, baseBranch: string) {
    const headCommit = yield* commit(root, "HEAD");
    const targetCommit = yield* commit(root, baseBranch);
    const ancestor = (yield* git(root, ["merge-base", targetCommit, headCommit])).trim();
    const baseCommit = yield* Schema.decodeUnknownEffect(Commit)(ancestor).pipe(
      Effect.mapError(() => new ReviewError({ operation: "merge-base", message: "The branches have no valid common ancestor." })),
    );
    const headBranch = (yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const output = yield* git(root, ["diff", "--name-status", "-z", "--find-renames", baseCommit, headCommit, "--"]);
    const files = yield* decodeFiles(output);
    return Review.make({ root, baseBranch, headBranch, baseCommit, headCommit, files });
  });

  const read = Effect.fn("BranchReview.read")(function* (input: Snapshot) {
    const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)(input).pipe(
      Effect.mapError(() => new ReviewError({ operation: "read snapshot", message: "Invalid snapshot." })),
    );
    if (snapshot.path === undefined) return "";
    return yield* git(snapshot.root, ["show", `${snapshot.commit}:${snapshot.path}`]);
  });

  return BranchReview.of({ branches, compare, read });
}));
