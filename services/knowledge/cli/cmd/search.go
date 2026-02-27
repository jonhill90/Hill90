package cmd

import (
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var searchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search knowledge entries",
	Long:  "Full-text search across knowledge entries.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		result, err := c.SearchEntries(args[0])
		if err != nil {
			return err
		}

		results, ok := result["results"].([]interface{})
		if !ok {
			fmt.Fprintln(os.Stdout, "no results")
			return nil
		}

		for _, r := range results {
			entry, ok := r.(map[string]interface{})
			if !ok {
				continue
			}
			fmt.Fprintf(os.Stdout, "%.2f  %-40s %s\n",
				entry["score"],
				entry["path"],
				entry["title"],
			)
			if headline, ok := entry["headline"].(string); ok {
				fmt.Fprintf(os.Stdout, "       %s\n", headline)
			}
		}
		return nil
	},
}
