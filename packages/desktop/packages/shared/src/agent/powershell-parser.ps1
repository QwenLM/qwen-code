# PowerShell AST Parser for Craft Agents
# Parses a command string and outputs a JSON AST for validation in Node.js
#
# Usage: pwsh -File powershell-parser.ps1 -Command "Get-Process | Select-Object Name"

param(
    [Parameter(Mandatory=$true)]
    [string]$Command
)

$ErrorActionPreference = 'Stop'

# Parse the command
$tokens = $null
$errors = $null

try {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $Command,
        [ref]$tokens,
        [ref]$errors
    )
} catch {
    # Return parse error as JSON
    @{
        success = $false
        error = $_.Exception.Message
    } | ConvertTo-Json -Compress
    exit 1
}

# Convert AST to serializable structure (avoiding circular Parent references)
function ConvertTo-SerializableAst {
    param($Node, [int]$Depth = 0)

    # Prevent infinite recursion
    if ($Depth -gt 20 -or $null -eq $Node) {
        return $null
    }

    $typeName = $Node.GetType().Name

    $result = @{
        Type = $typeName
        Text = $Node.Extent.Text
    }

    switch -Wildcard ($typeName) {
        'ScriptBlockAst' {
            if ($Node.BeginBlock) {
                $result.BeginBlock = ConvertTo-SerializableAst $Node.BeginBlock ($Depth + 1)
            }
            if ($Node.ProcessBlock) {
                $result.ProcessBlock = ConvertTo-SerializableAst $Node.ProcessBlock ($Depth + 1)
            }
            if ($Node.EndBlock) {
                $result.EndBlock = ConvertTo-SerializableAst $Node.EndBlock ($Depth + 1)
            }
            if ($Node.ParamBlock) {
                $result.ParamBlock = ConvertTo-SerializableAst $Node.ParamBlock ($Depth + 1)
            }
        }

        'NamedBlockAst' {
            $result.Statements = @($Node.Statements | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
            $result.Unnamed = $Node.Unnamed
        }

        'PipelineAst' {
            $result.PipelineElements = @($Node.PipelineElements | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
            $result.Background = $Node.Background
        }

        'CommandAst' {
            $result.CommandElements = @($Node.CommandElements | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
            $result.Redirections = @($Node.Redirections | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
            $result.InvocationOperator = $Node.InvocationOperator.ToString()
        }

        'CommandExpressionAst' {
            $result.Expression = ConvertTo-SerializableAst $Node.Expression ($Depth + 1)
        }

        'StringConstantExpressionAst' {
            $result.Value = $Node.Value
            $result.StringConstantType = $Node.StringConstantType.ToString()
        }

        'ExpandableStringExpressionAst' {
            $result.Value = $Node.Value
            $result.NestedExpressions = @($Node.NestedExpressions | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
        }

        'VariableExpressionAst' {
            $result.VariablePath = $Node.VariablePath.UserPath
            $result.Splatted = $Node.Splatted
        }

        'MemberExpressionAst' {
            $result.Expression = ConvertTo-SerializableAst $Node.Expression ($Depth + 1)
            $result.Member = ConvertTo-SerializableAst $Node.Member ($Depth + 1)
            $result.Static = $Node.Static
        }

        'InvokeMemberExpressionAst' {
            $result.Expression = ConvertTo-SerializableAst $Node.Expression ($Depth + 1)
            $result.Member = ConvertTo-SerializableAst $Node.Member ($Depth + 1)
            $result.Arguments = @($Node.Arguments | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
            $result.Static = $Node.Static
        }

        'SubExpressionAst' {
            $result.SubExpression = ConvertTo-SerializableAst $Node.SubExpression ($Depth + 1)
        }

        'ParenExpressionAst' {
            $result.Pipeline = ConvertTo-SerializableAst $Node.Pipeline ($Depth + 1)
        }

        'ScriptBlockExpressionAst' {
            $result.ScriptBlock = ConvertTo-SerializableAst $Node.ScriptBlock ($Depth + 1)
        }

        'ArrayExpressionAst' {
            $result.SubExpression = ConvertTo-SerializableAst $Node.SubExpression ($Depth + 1)
        }

        'ArrayLiteralAst' {
            $result.Elements = @($Node.Elements | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
        }

        'HashtableAst' {
            $result.KeyValuePairs = @($Node.KeyValuePairs | ForEach-Object {
                @{
                    Key = ConvertTo-SerializableAst $_.Item1 ($Depth + 1)
                    Value = ConvertTo-SerializableAst $_.Item2 ($Depth + 1)
                }
            })
        }

        'BinaryExpressionAst' {
            $result.Left = ConvertTo-SerializableAst $Node.Left ($Depth + 1)
            $result.Right = ConvertTo-SerializableAst $Node.Right ($Depth + 1)
            $result.Operator = $Node.Operator.ToString()
        }

        'UnaryExpressionAst' {
            $result.Child = ConvertTo-SerializableAst $Node.Child ($Depth + 1)
            $result.TokenKind = $Node.TokenKind.ToString()
        }

        'AssignmentStatementAst' {
            $result.Left = ConvertTo-SerializableAst $Node.Left ($Depth + 1)
            $result.Right = ConvertTo-SerializableAst $Node.Right ($Depth + 1)
            $result.Operator = $Node.Operator.ToString()
        }

        'FileRedirectionAst' {
            $result.Location = ConvertTo-SerializableAst $Node.Location ($Depth + 1)
            $result.Append = $Node.Append
            $result.FromStream = $Node.FromStream.ToString()
        }

        'MergingRedirectionAst' {
            $result.FromStream = $Node.FromStream.ToString()
            $result.ToStream = $Node.ToStream.ToString()
        }

        'IfStatementAst' {
            $result.Clauses = @($Node.Clauses | ForEach-Object {
                @{
                    Condition = ConvertTo-SerializableAst $_.Item1 ($Depth + 1)
                    Body = ConvertTo-SerializableAst $_.Item2 ($Depth + 1)
                }
            })
            if ($Node.ElseClause) {
                $result.ElseClause = ConvertTo-SerializableAst $Node.ElseClause ($Depth + 1)
            }
        }

        'ForEachStatementAst' {
            $result.Variable = ConvertTo-SerializableAst $Node.Variable ($Depth + 1)
            $result.Condition = ConvertTo-SerializableAst $Node.Condition ($Depth + 1)
            $result.Body = ConvertTo-SerializableAst $Node.Body ($Depth + 1)
        }

        'WhileStatementAst' {
            $result.Condition = ConvertTo-SerializableAst $Node.Condition ($Depth + 1)
            $result.Body = ConvertTo-SerializableAst $Node.Body ($Depth + 1)
        }

        'StatementBlockAst' {
            $result.Statements = @($Node.Statements | ForEach-Object {
                ConvertTo-SerializableAst $_ ($Depth + 1)
            })
        }

        'ConstantExpressionAst' {
            $result.Value = $Node.Value
        }

        'CommandParameterAst' {
            $result.ParameterName = $Node.ParameterName
            if ($Node.Argument) {
                $result.Argument = ConvertTo-SerializableAst $Node.Argument ($Depth + 1)
            }
        }

        'IndexExpressionAst' {
            $result.Target = ConvertTo-SerializableAst $Node.Target ($Depth + 1)
            $result.Index = ConvertTo-SerializableAst $Node.Index ($Depth + 1)
        }

        default {
            # For any other node type, just capture the text
            # This ensures we don't miss anything
        }
    }

    return $result
}

# Build the output
$output = @{
    success = $true
    ast = ConvertTo-SerializableAst $ast 0
    parseErrors = @($errors | ForEach-Object {
        @{
            Message = $_.Message
            Text = $_.Extent.Text
            ErrorId = $_.ErrorId
        }
    })
}

# Output as JSON
$output | ConvertTo-Json -Depth 30 -Compress
