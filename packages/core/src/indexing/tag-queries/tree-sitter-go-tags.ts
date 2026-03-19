export const TREE_SITTER_GO_TAGS = `
; Go tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Function declarations: func foo() {}
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Method declarations: func (r Receiver) foo() {}
(method_declaration
  name: (field_identifier) @name.definition.method) @definition.method

; Type declarations: type Foo struct/interface/...
(type_spec
  name: (type_identifier) @name.definition.type) @definition.type

; ===== References =====

; Function/method calls
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (selector_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; Type references
(type_identifier) @name.reference.type @reference.type

`;
