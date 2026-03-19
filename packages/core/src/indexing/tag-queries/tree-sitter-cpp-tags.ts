export const TREE_SITTER_CPP_TAGS = `
; C++ tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Class definitions: class Foo {}
(class_specifier
  name: (type_identifier) @name.definition.class) @definition.class

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

; Function declarations with field identifier
(function_declarator
  declarator: (field_identifier) @name.definition.function) @definition.function

; Qualified method definitions: void Foo::bar() {}
(function_declarator
  declarator: (qualified_identifier
    name: (identifier) @name.definition.method)) @definition.method

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

; Method calls: obj.foo() or obj->foo()
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; Scoped calls: Foo::bar()
(call_expression
  function: (qualified_identifier
    name: (identifier) @name.reference.call)) @reference.call

`;
