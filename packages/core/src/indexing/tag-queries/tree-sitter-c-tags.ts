export const TREE_SITTER_C_TAGS = `
; C tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Struct definitions: struct Foo {}
(struct_specifier
  name: (type_identifier) @name.definition.class
  body: (_)) @definition.class

; Union definitions: union Foo {}
(declaration
  type: (union_specifier
    name: (type_identifier) @name.definition.class)) @definition.class

; Function declarations: void foo() {}
(function_declarator
  declarator: (identifier) @name.definition.function) @definition.function

; Type definitions: typedef int Foo;
(type_definition
  declarator: (type_identifier) @name.definition.type) @definition.type

; Enum definitions: enum Foo {}
(enum_specifier
  name: (type_identifier) @name.definition.type) @definition.type

; ===== References =====

; Function calls: foo()
(call_expression
  function: (identifier) @name.reference.call) @reference.call

`;
