export const TREE_SITTER_PHP_TAGS = `
; PHP tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Class declarations: class Foo {}
(class_declaration
  name: (name) @name.definition.class) @definition.class

; Function definitions: function foo() {}
(function_definition
  name: (name) @name.definition.function) @definition.function

; Method declarations: public function foo() {}
(method_declaration
  name: (name) @name.definition.method) @definition.method

; ===== References =====

; Object creation: new Foo()
(object_creation_expression
  [
    (qualified_name (name) @name.reference.class)
    (variable_name (name) @name.reference.class)
  ]) @reference.class

; Function calls: foo()
(function_call_expression
  function: [
    (qualified_name (name) @name.reference.call)
    (variable_name (name)) @name.reference.call
  ]) @reference.call

; Scoped calls: Foo::bar()
(scoped_call_expression
  name: (name) @name.reference.call) @reference.call

; Method calls: $obj->foo()
(member_call_expression
  name: (name) @name.reference.call) @reference.call

`;
