export const TREE_SITTER_JSX_TAGS = `
; JavaScript tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Function declarations: function foo() {}
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Generator function declarations: function* foo() {}
(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Arrow function / function expression assigned to const/let/var
; const foo = () => {} or const foo = function() {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)])) @definition.function

; var foo = () => {} or var foo = function() {}
(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)])) @definition.function

; Assignment: foo = () => {} or foo = function() {}
(assignment_expression
  left: (identifier) @name.definition.function
  right: [(arrow_function) (function_expression)]) @definition.function

; Method definitions: class C { foo() {} }
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

; Class declarations: class Foo {}
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

; Class expressions assigned to variables: const Foo = class {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.class
    value: (class))) @definition.class

; ===== References =====

; Function calls: foo() (exclude require)
(call_expression
  function: (identifier) @name.reference.call) @reference.call

; Method calls: obj.foo()
(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

`;
