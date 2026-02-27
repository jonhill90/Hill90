package cmd

import (
	"fmt"
	"os"

	"github.com/hill90/akm/client"
	"github.com/spf13/cobra"
)

var readCmd = &cobra.Command{
	Use:   "read <path>",
	Short: "Read a knowledge entry",
	Long:  "Read a knowledge entry by path and output its content to stdout.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client.NewFromEnv()
		if err != nil {
			return err
		}

		entry, err := c.ReadEntry(args[0])
		if err != nil {
			return err
		}

		content, ok := entry["content"].(string)
		if !ok {
			return fmt.Errorf("unexpected content type in response")
		}

		fmt.Fprint(os.Stdout, content)
		return nil
	},
}
