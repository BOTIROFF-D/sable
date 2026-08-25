import type { Span } from './errors.ts';

export type Param = { name: string; def: Expr | null };

export type Expr =
  | { kind: 'Number'; value: number; span: Span }
  | { kind: 'Str'; value: string; span: Span }
  | { kind: 'Template'; parts: Array<{ text: string } | { expr: Expr }>; span: Span }
  | { kind: 'Bool'; value: boolean; span: Span }
  | { kind: 'Nil'; span: Span }
  | { kind: 'List'; items: Expr[]; span: Span }
  | { kind: 'Map'; entries: Array<{ key: Expr; value: Expr }>; span: Span }
  | { kind: 'Ident'; name: string; span: Span }
  | { kind: 'Unary'; op: string; right: Expr; span: Span }
  | { kind: 'Binary'; op: string; left: Expr; right: Expr; span: Span }
  | { kind: 'Logical'; op: string; left: Expr; right: Expr; span: Span }
  | { kind: 'Ternary'; cond: Expr; then: Expr; else: Expr; span: Span }
  | { kind: 'Range'; start: Expr; end: Expr; span: Span }
  | { kind: 'Call'; callee: Expr; args: Expr[]; span: Span }
  | { kind: 'Get'; object: Expr; name: string; span: Span }
  | { kind: 'Index'; object: Expr; index: Expr; span: Span }
  | { kind: 'Assign'; op: string | null; target: Expr; value: Expr; span: Span }
  | { kind: 'Fn'; name: string | null; params: Param[]; body: Stmt[]; span: Span };

export type Stmt =
  | { kind: 'VarDecl'; mutable: boolean; name: string; init: Expr; span: Span }
  | { kind: 'FnDecl'; name: string; params: Param[]; body: Stmt[]; span: Span }
  | { kind: 'StructDecl'; name: string; fields: Param[]; methods: Array<{ name: string; params: Param[]; body: Stmt[]; span: Span }>; span: Span }
  | { kind: 'Import'; path: string; alias: string; span: Span }
  | { kind: 'ExprStmt'; expr: Expr; span: Span }
  | { kind: 'Block'; body: Stmt[]; span: Span }
  | { kind: 'If'; cond: Expr; then: Stmt; else: Stmt | null; span: Span }
  | { kind: 'While'; cond: Expr; body: Stmt; span: Span }
  | { kind: 'For'; name: string; iterable: Expr; body: Stmt; span: Span }
  | { kind: 'Try'; body: Stmt[]; param: string | null; handler: Stmt[]; span: Span }
  | { kind: 'Return'; value: Expr | null; span: Span }
  | { kind: 'Break'; span: Span }
  | { kind: 'Continue'; span: Span };

export type Program = Stmt[];
