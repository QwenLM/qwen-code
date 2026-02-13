export const TREE_SITTER_RUBY_TAGS = `
; Ruby tag queries for symbol extraction
; Captures definitions (@name.definition.* + @definition.*) and references (@name.reference.*)

; ===== Definitions =====

; Method definitions: def foo; end
(method
  name: (_) @name.definition.method) @definition.method

; Singleton method definitions: def self.foo; end
(singleton_method
  name: (_) @name.definition.method) @definition.method

; Alias definitions: alias new_name old_name
(alias
  name: (_) @name.definition.method) @definition.method

; Class definitions: class Foo; end
(class
  name: (constant) @name.definition.class) @definition.class

(class
  name: (scope_resolution
    name: (_) @name.definition.class)) @definition.class

; Singleton class: class << self
(singleton_class
  value: (constant) @name.definition.class) @definition.class

; Module definitions: module Foo; end
(module
  name: (constant) @name.definition.module) @definition.module

(module
  name: (scope_resolution
    name: (_) @name.definition.module)) @definition.module

; ===== References =====

; Method calls: foo() or obj.foo()
(call
  method: (identifier) @name.reference.call) @reference.call

`;
