# Web Shell context boundary

## Problem

Message rendering modules import shared React contexts from the application coordinator, while the application coordinator imports those message modules. The contexts are dependency-neutral, but their ownership creates a runtime import cycle and forces focused component tests to mock the full application module.

## Design

Move the compact-mode context, todo timeline context, todo detail context, and the existing todo provider into one small Web Shell context module. Keep all state creation and memoization in the application coordinator, preserve the existing provider values, and update consumers to import the contexts directly.

## Non-goals

- Move todo state or compact-mode state out of the application coordinator.
- Introduce a new state-management abstraction.
- Change provider nesting, context defaults, or rendering behavior.
