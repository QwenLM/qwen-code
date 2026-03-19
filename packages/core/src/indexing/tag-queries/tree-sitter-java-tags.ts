export const TREE_SITTER_JAVA_TAGS = `
; Java tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Class declarations: class Foo {}
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

; Interface declarations: interface Foo {}
(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

; Enum declarations: enum Foo {}
(enum_declaration
  name: (identifier) @name.definition.type) @definition.type

; Method declarations: void foo() {}
(method_declaration
  name: (identifier) @name.definition.method) @definition.method

; Constructor declarations: Foo() {}
(constructor_declaration
  name: (identifier) @name.definition.method) @definition.method

; ===== References =====

; Method invocations: foo()
(method_invocation
  name: (identifier) @name.reference.call) @reference.call

; Object creation: new Foo()
(object_creation_expression
  type: (type_identifier) @name.reference.class) @reference.class

; Superclass: class Foo extends Bar
(superclass (type_identifier) @name.reference.class) @reference.class

; Interface implementations: implements Foo, Bar
(type_list
  (type_identifier) @name.reference.type) @reference.type

`;
