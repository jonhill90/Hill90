package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var writeTitle string

var writeCmd = &cobra.Command{
	Use:   "write <path> [--title <title>]",
	Short: "Write a knowledge entry",
	Long:  "Create or update a knowledge entry. Reads content from stdin if no file argument.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		path := args[0]

		// Read content from stdin
		content, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}

		contentStr := string(content)
		if strings.TrimSpace(contentStr) == "" {
			return fmt.Errorf("no content provided (pipe content to stdin)")
		}

		// If content doesn't start with frontmatter and title is provided, wrap it
		if !strings.HasPrefix(strings.TrimSpace(contentStr), "---") && writeTitle != "" {
			entryType := inferType(path)
			contentStr = fmt.Sprintf("---\ntitle: %s\ntype: %s\n---\n%s", writeTitle, entryType, contentStr)
		}

		entry, err := c.CreateEntry(path, contentStr)
		if err != nil {
			return err
		}

		fmt.Fprintf(os.Stdout, "created: %s (%s)\n", entry["path"], entry["id"])
		return nil
	},
}

func init() {
	writeCmd.Flags().StringVar(&writeTitle, "title", "", "Entry title (auto-wraps with frontmatter)")
}

func inferType(path string) string {
	if strings.HasPrefix(path, "plans/") {
		return "plan"
	}
	if strings.HasPrefix(path, "decisions/") {
		return "decision"
	}
	if strings.HasPrefix(path, "journal/") {
		return "journal"
	}
	if strings.HasPrefix(path, "research/") {
		return "research"
	}
	if path == "context.md" {
		return "context"
	}
	return "note"
}
