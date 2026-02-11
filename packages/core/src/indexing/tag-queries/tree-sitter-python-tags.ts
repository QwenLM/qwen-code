export const TREE_SITTER_PYTHON_TAGS = `
; Python tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Function definitions: def foo():
(function_definition
  name: (identifier) @name.definition.function) @definition.function

; Method definitions: class methods (function nested in class body)
(class_definition
  body: (block
    (function_definition
      name: (identifier) @name.definition.method) @definition.method))

; Method definitions: decorated methods
(class_definition
  body: (block
    (decorated_definition
      definition: (function_definition
        name: (identifier) @name.definition.method) @definition.method)))

; Class definitions: class Foo:
(class_definition
  name: (identifier) @name.definition.class) @definition.class

; Module-level variable assignments: x = 42
(module
  (expression_statement
    (assignment
      left: (identifier) @name.definition.variable) @definition.variable))

; ===== References =====

; Function/method calls: foo() or obj.foo()
(call
  function: (identifier) @name.reference.call) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)) @reference.call

`;
