export const TREE_SITTER_RUST_TAGS = `
; Rust tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Function definitions: fn foo() {}
(function_item
  name: (identifier) @name.definition.function) @definition.function

; Methods inside impl blocks: impl Foo { fn bar() {} }
(declaration_list
  (function_item
    name: (identifier) @name.definition.method)) @definition.method

; Struct definitions: struct Foo {}
(struct_item
  name: (type_identifier) @name.definition.class) @definition.class

; Enum definitions: enum Foo {}
(enum_item
  name: (type_identifier) @name.definition.class) @definition.class

; Union definitions: union Foo {}
(union_item
  name: (type_identifier) @name.definition.class) @definition.class

; Type aliases: type Foo = ...
(type_item
  name: (type_identifier) @name.definition.type) @definition.type

; Trait definitions: trait Foo {}
(trait_item
  name: (type_identifier) @name.definition.interface) @definition.interface

; Module definitions: mod foo {}
(mod_item
  name: (identifier) @name.definition.module) @definition.module

; Macro definitions: macro_rules! foo {}
(macro_definition
  name: (identifier) @name.definition.function) @definition.function

; ===== References =====

; Function calls: foo()
(call_expression
  function: (identifier) @name.reference.call) @reference.call

; Method calls: obj.foo()
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; Macro invocations: foo!()
(macro_invocation
  macro: (identifier) @name.reference.call) @reference.call

; Impl trait: impl Trait for Type
(impl_item
  trait: (type_identifier) @name.reference.type) @reference.type

; Impl type (self impl): impl Type
(impl_item
  type: (type_identifier) @name.reference.type
  !trait) @reference.type

`;
