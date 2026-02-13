export const TREE_SITTER_CSHARP_TAGS = `
; C# tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Class declarations: class Foo {}
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

; Interface declarations: interface IFoo {}
(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

; Method declarations: void Foo() {}
(method_declaration
  name: (identifier) @name.definition.method) @definition.method

; Namespace declarations: namespace Foo {}
(namespace_declaration
  name: (identifier) @name.definition.module) @definition.module

; ===== References =====

; Object creation: new Foo()
(object_creation_expression
  type: (identifier) @name.reference.class) @reference.class

; Method calls: obj.Foo()
(invocation_expression
  function: (member_access_expression
    name: (identifier) @name.reference.call)) @reference.call

; Variable type: Foo x = ...
(variable_declaration
  type: (identifier) @name.reference.type) @reference.type

`;
