package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var contextRaw bool

var contextCmd = &cobra.Command{
	Use:   "context",
	Short: "Get context summary",
	Long:  "Retrieve the deterministic context summary for this agent.",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		result, err := c.GetContext()
		if err != nil {
			return err
		}

		if contextRaw {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(result)
		}

		// Pretty print sections
		sections, ok := result["sections"].([]interface{})
		if !ok {
			fmt.Fprintln(os.Stdout, "(no context)")
			return nil
		}

		for _, s := range sections {
			section, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			fmt.Fprintf(os.Stdout, "## [%s] %s (%s)\n",
				section["type"],
				section["title"],
				section["path"],
			)
			if content, ok := section["content"].(string); ok {
				fmt.Fprintln(os.Stdout, content)
			}
			fmt.Fprintln(os.Stdout)
		}

		fmt.Fprintf(os.Stdout, "---\ntokens: %.0f / %.0f\n",
			result["token_count"],
			result["token_budget"],
		)
		return nil
	},
}

func init() {
	contextCmd.Flags().BoolVar(&contextRaw, "raw", false, "Output raw JSON")
}
