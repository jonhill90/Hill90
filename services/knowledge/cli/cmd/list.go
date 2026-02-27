package cmd

import (
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var listType string

var listCmd = &cobra.Command{
	Use:   "list [--type <type>]",
	Short: "List knowledge entries",
	Long:  "List all knowledge entries, optionally filtered by type.",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		entries, err := c.ListEntries(listType)
		if err != nil {
			return err
		}

		for _, entry := range entries {
			fmt.Fprintf(os.Stdout, "%-8s %-40s %s\n",
				entry["entry_type"],
				entry["path"],
				entry["title"],
			)
		}
		return nil
	},
}

func init() {
	listCmd.Flags().StringVar(&listType, "type", "", "Filter by entry type (plan, decision, journal, etc.)")
}
