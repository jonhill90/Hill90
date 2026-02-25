package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var journalCmd = &cobra.Command{
	Use:   "journal",
	Short: "Append to today's journal",
	Long:  "Append content to today's journal entry. Reads from stdin.",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		content, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("read stdin: %w", err)
		}

		contentStr := strings.TrimSpace(string(content))
		if contentStr == "" {
			return fmt.Errorf("no content provided (pipe content to stdin)")
		}

		entry, err := c.AppendJournal(contentStr)
		if err != nil {
			return err
		}

		fmt.Fprintf(os.Stdout, "appended to: %s\n", entry["path"])
		return nil
	},
}
