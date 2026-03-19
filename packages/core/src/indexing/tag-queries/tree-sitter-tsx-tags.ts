export const TREE_SITTER_TSX_TAGS = `
; TypeScript tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Function declarations: function foo() {}
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Arrow function / function expression assigned to const/let/var
; const foo = () => {} or const foo = function() {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)])) @definition.function

; Method definitions: class C { foo() {} }
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

; Class declarations: class Foo {}
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

; Abstract class declarations: abstract class Foo {}
(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

; Interface declarations: interface Foo {}
(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

; Type alias declarations: type Foo = ...
(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

; Enum declarations: enum Foo {}
(enum_declaration
  name: (identifier) @name.definition.type) @definition.type

; Function signatures (in interfaces/declarations): foo(): void
(function_signature
  name: (identifier) @name.definition.function) @definition.function

; Method signatures: foo(): void (in interfaces)
(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

; Abstract method signatures: abstract foo(): void
(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

; ===== References =====

; Function calls: foo()
(call_expression
  function: (identifier) @name.reference.call) @reference.call

; Method calls: obj.foo()
(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

; Type references in annotations: x: Foo
(type_annotation
  (type_identifier) @name.reference.type) @reference.type

; Type references in generics: Foo<Bar>
(generic_type
  (type_identifier) @name.reference.type) @reference.type

`;
